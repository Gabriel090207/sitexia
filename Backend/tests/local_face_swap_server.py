"""Loopback-only integrated test app. Never imports production Firebase/deepswap.

Start only with all three emulator environment variables explicitly set.
All user/balance data is disposable and belongs to a demo project.
"""
import base64
import json
import os
from pathlib import Path
import socket
import sys
import types
from urllib.parse import quote
from urllib.request import Request, urlopen

EXPECTED = {'FIRESTORE_EMULATOR_HOST': '127.0.0.1:8787',
            'FIREBASE_AUTH_EMULATOR_HOST': '127.0.0.1:9099',
            'STORAGE_EMULATOR_HOST': 'http://127.0.0.1:9299'}
if any(os.environ.get(key) != value for key, value in EXPECTED.items()):
    raise RuntimeError('Refusing to start without dedicated loopback emulators')
PROJECT = 'demo-xiaswap-finance-tests'
BUCKET = PROJECT + '.appspot.com'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
# Fail closed for Python outbound HTTP, including any accidental ADC request.
original_connect = socket.create_connection
def local_connection(address, *args, **kwargs):
    if address[0] not in ('127.0.0.1', 'localhost', '::1'):
        raise RuntimeError('External network blocked by local test guard')
    return original_connect(address, *args, **kwargs)
socket.create_connection = local_connection
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
import firebase_admin
from firebase_admin import credentials
class DemoCredentials(credentials.Base):
    def get_credential(self):
        return AnonymousCredentials()
firebase_admin.initialize_app(DemoCredentials(), {'projectId': PROJECT})
db = firestore.Client(project=PROJECT, credentials=AnonymousCredentials())

class EmulatorBlob:
    def __init__(self, path):
        self.path = path
    def reload(self):
        request = Request(f'http://127.0.0.1:9299/v0/b/{BUCKET}/o/{quote(self.path, safe="")}',
                          headers={'Authorization': 'Bearer owner'})
        with urlopen(request, timeout=5) as response:
            metadata = json.load(response)
        self.generation, self.content_type, self.size = metadata['generation'], metadata['contentType'], int(metadata['size'])
    def generate_signed_url(self, **kwargs):
        assert kwargs['generation'] == str(self.generation)
        return 'http://127.0.0.1:8789/__test/output.png'
class EmulatorBucket:
    name = BUCKET
    def blob(self, path):
        return EmulatorBlob(path)
firebase_stub = types.ModuleType('app.services.firebase')
firebase_stub.db, firebase_stub.bucket = db, EmulatorBucket()
sys.modules['app.services.firebase'] = firebase_stub

state = {'scenario': 'success', 'materialCreates': 0, 'taskCreates': 0, 'taskPosts': 0,
         'taskGets': 0, 'release': True, 'tasks': {}, 'materials': {}}
async def create_material(url):
    state['materialCreates'] += 1
    identifier = str(1000 + state['materialCreates'])
    state['materials'][identifier] = {'materialId': identifier, 'status': 'SUCCEEDED',
        'materialType': 'IMAGE', 'faces': [{'id': '5'}]}
    return {'materialId': identifier, 'status': 'PENDING'}
async def get_material(identifier):
    return state['materials'][identifier]
async def create_task(material, face, target):
    state['taskCreates'] += 1
    identifier = str(2000 + state['taskCreates'])
    state['tasks'][identifier] = state['scenario']
    if state['scenario'] == 'unconfirmed':
        import httpx
        raise httpx.ReadTimeout('Simulated creation with lost provider response')
    return {'taskId': identifier, 'taskStatus': 'PENDING'}
async def get(uri, **kwargs):
    identifier = uri.rsplit('/', 1)[-1]
    state['taskGets'] += 1
    scenario = state['tasks'][identifier]
    status = 'RUNNING' if not state['release'] else ('FAILED' if scenario == 'failed' else 'SUCCEEDED')
    return {'taskId': identifier, 'taskStatus': status, 'imageUrls': ['http://127.0.0.1:8789/__test/output.png']}
provider = types.ModuleType('app.services.deepswap')
for name, function in {'create_material': create_material, 'get_material': get_material,
                       'create_task': create_task, 'get': get, 'get_task': lambda identifier: get('/tasks/' + identifier)}.items():
    setattr(provider, name, function)
sys.modules['app.services.deepswap'] = provider
from fastapi import FastAPI, HTTPException, Request as HttpRequest
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from app.routes.swap import router
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:5179'],
                   allow_methods=['*'], allow_headers=['*'])
app.include_router(router)
@app.middleware('http')
async def count_posts(request, call_next):
    if request.url.path == '/swap/task' and request.method == 'POST': state['taskPosts'] += 1
    return await call_next(request)
@app.post('/__test/setup')
async def setup(request: HttpRequest):
    body = await request.json()
    uid = body['uid']
    if not isinstance(uid, str) or '/' in uid: raise HTTPException(400)
    state['scenario'] = body.get('scenario', 'success')
    state['release'] = body.get('release', True)
    if body.get('seed', False): db.collection('users').document(uid).set({'credits': 10.0, 'reservedCredits': 0.0})
    return {'project': PROJECT, 'scenario': state['scenario']}
@app.get('/__test/state/{uid}')
def read_state(uid: str):
    records = list(db.collection('generations').where(filter=firestore.FieldFilter('userId', '==', uid)).stream())
    return {**{k: v for k, v in state.items() if k not in ('tasks', 'materials')},
            'user': db.collection('users').document(uid).get().to_dict(),
            'operations': [{'id': doc.id, 'creditStatus': doc.to_dict().get('creditStatus'),
                            'status': doc.to_dict().get('status')} for doc in records]}
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')
@app.get('/__test/output.png')
def output(): return Response(PNG, media_type='image/png')
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8789, access_log=False)
