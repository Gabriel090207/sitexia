"""Offline download authorization contracts; no Firebase initialization or I/O."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from urllib.parse import quote
from unittest.mock import Mock, patch

from google.api_core.exceptions import NotFound
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
firebase = types.ModuleType('app.services.firebase')
firebase.db = Mock()
firebase.bucket = Mock()
spec = importlib.util.spec_from_file_location(
    'tested_download_routes', Path(__file__).resolve().parents[1] / 'app/routes/download.py')
routes = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'app.services.firebase': firebase}):
    spec.loader.exec_module(routes)


class DownloadAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.db = Mock()
        self.bucket = Mock()
        self.bucket.name = 'test-bucket'
        self.snapshot = self.db.collection.return_value.document.return_value.collection.return_value.document.return_value.get.return_value
        self.snapshot.exists = True
        self.item = {'imageUrl': self.url('users/alice/swaps/result.png')}
        self.snapshot.to_dict.side_effect = lambda: self.item
        self.bucket.blob.return_value.content_type = 'image/png'
        self.bucket.blob.return_value.download_as_bytes.return_value = b'result'
        for name, value in [('db', self.db), ('bucket', self.bucket), ('create_video_access', Mock(return_value={'url':'https://storage.googleapis.com/demo/v.mp4?X-Goog-Signature=fake','contentType':'video/mp4'}))]:
            p = patch.object(routes, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.client = TestClient(self.app)
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('alice', {})

    @staticmethod
    def url(path, bucket='test-bucket'):
        return f'https://firebasestorage.googleapis.com/v0/b/{bucket}/o/{quote(path, safe="")}?alt=media&token=not-a-real-token'

    def get(self, uid='alice'):
        return self.client.get(f'/download/{uid}/item', params={'delivery':'direct'})

    def test_own_supported_results_and_legacy_missing_type(self):
        for kind, folder, field, mime in [
            (None, 'swaps', 'imageUrl', 'image/png'),
            ('face-swap', 'swaps', 'imageUrl', 'image/png'),
            ('image-generation', 'images/batch/0', 'imageUrl', 'image/png'),
            ('video-generation', 'videos', 'videoUrl', 'video/mp4'),
        ]:
            self.item = {field: self.url(f'users/alice/{folder}/result.png')}
            if kind:
                self.item['type'] = kind
            self.bucket.blob.return_value.content_type = mime
            response = self.get()
            self.assertEqual(response.status_code, 200)
            if kind == 'video-generation':
                self.assertEqual(response.json()['contentType'], mime)
                continue
            self.assertEqual(response.content, b'result')
            self.assertEqual(response.headers['content-type'], mime)
            self.assertEqual(response.headers['cache-control'], 'private, no-store')
            self.assertNotIn('token', str(response.headers))

    def test_other_user_denied_before_admin_lookup(self):
        self.assertEqual(self.get('bob').status_code, 403)
        self.db.collection.assert_not_called()

    def test_missing_and_invalid_authentication(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.get().status_code, 401)
        with patch('app.dependencies.auth.auth.verify_id_token', side_effect=ValueError):
            response = self.client.get('/download/alice/item', headers={'Authorization': 'Bearer invalid'})
        self.assertEqual(response.status_code, 401)
        self.db.collection.assert_not_called()

    def test_missing_record_and_object(self):
        self.snapshot.exists = False
        self.assertEqual(self.get().status_code, 404)
        self.bucket.blob.assert_not_called()
        self.snapshot.exists = True
        self.bucket.blob.return_value.reload.side_effect = NotFound('missing')
        self.assertEqual(self.get().status_code, 404)

    def test_untrusted_references_never_access_storage(self):
        urls = [
            self.url('users/bob/swaps/result.png'),
            self.url('users/alice/swaps/../bob/result.png'),
            self.url('users/alice/swaps/%2e%2e/result.png'),
            self.url('users/alice/swaps/\\result.png'),
            self.url('users/alice/swaps//result.png'),
            self.url('face-swap/alice/result.png'),
            self.url('users/alice-evil/swaps/result.png'),
            self.url('users/alice/swaps/result.png', 'other-bucket'),
            'https://external.invalid/o/users%2Falice%2Fswaps%2Fresult.png',
            self.url('users/alice/swaps/result.png').replace('https:', 'http:'),
            self.url('users/alice/swaps/result.png').replace('.com/', '.com.evil/'),
            123,
        ]
        for url in urls:
            with self.subTest(url=url):
                self.item = {'imageUrl': url}
                response = self.get()
                self.assertEqual(response.status_code, 403)
                self.assertNotIn('not-a-real-token', response.text)
                self.bucket.blob.assert_not_called()

    def test_invalid_type_and_missing_url(self):
        self.item = {'type': 'unknown'}
        self.assertEqual(self.get().status_code, 400)
        self.item = {}
        self.assertEqual(self.get().status_code, 404)


if __name__ == '__main__':
    unittest.main()
