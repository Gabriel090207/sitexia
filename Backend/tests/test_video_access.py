"""Offline access/signing contracts. No production credentials or Storage I/O."""
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import quote

from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.api_core.exceptions import NotFound

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

firebase = types.ModuleType('app.services.firebase')
firebase.db, firebase.bucket = Mock(), Mock()
with patch.dict(sys.modules, {'app.services.firebase': firebase}):
    service = load('tested_video_access', 'app/services/video_access.py')
with patch.dict(sys.modules, {'app.services.video_access': service}):
    routes = load('tested_media_route', 'app/routes/media.py')


class VideoAccessTests(unittest.TestCase):
    def setUp(self):
        self.db, self.bucket = Mock(), Mock()
        self.bucket.name = 'demo-bucket'
        self.blob = self.bucket.blob.return_value
        self.blob.generation, self.blob.size, self.blob.content_type = 123, 1024, 'video/mp4'
        self.signed = 'https://storage.invalid/object?X-Goog-Signature=private-signature'
        self.blob.generate_signed_url.return_value = self.signed
        self.ref = self.db.collection.return_value.document.return_value.collection.return_value.document.return_value
        self.ref.get.return_value.exists = True
        self.item = {'type': 'video-generation', 'videoUrl': self.url('users/alice/videos/output.mp4')}
        self.ref.get.return_value.to_dict.side_effect = lambda: self.item
        self.now = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
        for p in (patch.object(service, 'db', self.db), patch.object(service, 'bucket', self.bucket),
                  patch.object(service, 'datetime')):
            value = p.start()
            if value is service.datetime:
                value.now.return_value = self.now
            self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('alice', {})
        self.app, self.http = app, TestClient(app)

    @staticmethod
    def url(path, token=True):
        return 'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/' + quote(path, safe='') + ('?alt=media&token=private-token' if token else '')

    def request(self):
        return self.http.post('/media/item/video-access')

    def test_own_video_token_and_token_free_references(self):
        for token in (True, False):
            self.item['videoUrl'] = self.url('users/alice/videos/output.mp4', token)
            response = self.request()
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['url'], self.signed)
            self.assertEqual(response.json()['mediaType'], 'video')
            self.assertEqual(response.json()['origin'], 'video-generation')
            self.assertEqual(response.headers['cache-control'], 'private, no-store')
            self.assertNotIn('private-token', response.text)
        self.db.collection.assert_called_with('users')
        self.db.collection.return_value.document.assert_called_with('alice')
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()
        self.blob.download_as_bytes.assert_not_called()

    def test_signature_contract_expiration_and_no_fixed_range(self):
        self.assertEqual(self.request().status_code, 200)
        args = self.blob.generate_signed_url.call_args.kwargs
        self.assertEqual(args, {'version': 'v4', 'expiration': self.now + timedelta(minutes=30),
            'method': 'GET', 'generation': '123', 'response_type': 'video/mp4',
            'response_disposition': 'inline', 'scheme': 'https'})
        body = self.request().json()
        self.assertEqual(body['expiresInSeconds'], 1800)
        self.assertEqual(datetime.fromisoformat(body['expiresAt']), self.now + timedelta(minutes=30))
        self.assertNotIn('headers', args)

    def test_face_swap_video_and_legacy_without_type(self):
        for kind in ('face-swap', None, 'image-generation'):
            self.item = {'imageUrl': self.url('users/alice/swaps/legacy.webm')}
            if kind is not None: self.item['type'] = kind
            self.blob.content_type = 'video/webm'
            response = self.request()
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['origin'], 'face-swap')
            self.assertEqual(response.json()['contentType'], 'video/webm')

    def test_same_id_is_read_only_in_authenticated_namespace(self):
        # No caller-supplied UID exists in this contract, even if a record points outside it.
        self.item['videoUrl'] = self.url('users/bob/videos/private.mp4')
        self.assertEqual(self.request().status_code, 403)
        self.bucket.blob.assert_not_called()
        self.blob.generate_signed_url.assert_not_called()

    def test_missing_and_invalid_firebase_token(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.request().status_code, 401)
        with patch('app.dependencies.auth.auth.verify_id_token', side_effect=ValueError('private-token')):
            response = self.http.post('/media/item/video-access', headers={'Authorization': 'Bearer invalid'})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn('private-token', response.text)
        self.db.collection.assert_not_called()

    def test_untrusted_references_never_reach_storage(self):
        for value in [self.url('users/bob/videos/file.mp4'),
                      self.url('users/alice/videos/../bob/file.mp4'),
                      self.url('users/alice/videos/%2e%2e/file.mp4'),
                      self.url('users/alice/videos/\\file.mp4'),
                      self.url('users/alice/videos//file.mp4'),
                      self.url('video-generation/alice/file.mp4'),
                      self.url('users/alice/videos/file.mp4').replace('demo-bucket','wrong-bucket'),
                      'https://external.invalid/private.mp4',
                      self.url('users/alice/videos/file.mp4').replace('https:','http:'),
                      self.url('users/alice/videos/file.mp4').replace('googleapis.com','googleapis.com.evil'), 123]:
            with self.subTest(value=value):
                self.item = {'videoUrl': value}
                response = self.request()
                self.assertEqual(response.status_code, 403)
                self.assertNotIn('private-token', response.text)
        self.bucket.blob.assert_not_called()

    def test_missing_record_object_and_storage_errors(self):
        self.ref.get.return_value.exists = False
        self.assertEqual(self.request().status_code, 404)
        self.ref.get.return_value.exists = True
        for error, status in [(NotFound('private-token'),404), (RuntimeError('private-token'),503)]:
            self.blob.reload.side_effect = error
            response = self.request()
            self.assertEqual(response.status_code, status)
            self.assertNotIn('private-token', response.text)
        self.blob.generate_signed_url.assert_not_called()

    def test_image_or_unknown_mime_never_signed_even_if_named_mp4(self):
        for mime in ('image/png', 'text/html', 'application/octet-stream', None):
            self.blob.content_type = mime
            self.assertEqual(self.request().status_code, 415)
        self.blob.generate_signed_url.assert_not_called()

    def test_wrong_result_directory_rejected(self):
        self.item = {'videoUrl': self.url('users/alice/images/batch/result.mp4')}
        self.assertEqual(self.request().status_code, 415)
        self.bucket.blob.assert_not_called()

    def test_bad_metadata(self):
        for field, value in [('generation',None), ('generation','invalid'), ('generation',0), ('size',0), ('size',True)]:
            original = getattr(self.blob,field)
            setattr(self.blob,field,value)
            self.assertEqual(self.request().status_code,409)
            setattr(self.blob,field,original)
        self.blob.generate_signed_url.assert_not_called()

    def test_signing_failure_and_logs_hide_sensitive_data(self):
        self.blob.generate_signed_url.side_effect = RuntimeError('private-signature private-token https://private.invalid')
        with self.assertLogs(service.logger,level='WARNING') as logs:
            response = self.request()
        self.assertEqual(response.status_code,503)
        for value in ('private-signature','private-token','private.invalid'):
            self.assertNotIn(value,response.text)
            self.assertNotIn(value,' '.join(logs.output))

    def test_replacement_does_not_change_signed_generation(self):
        def sign(**kwargs):
            self.blob.generation = 124
            self.assertEqual(kwargs['generation'],'123')
            return self.signed
        self.blob.generate_signed_url.side_effect = sign
        self.assertEqual(self.request().status_code,200)

    def test_ambiguous_missing_and_duplicate_references(self):
        self.item = {}
        self.assertEqual(self.request().status_code,404)
        self.item = {'videoUrl':self.url('users/alice/videos/1.mp4'), 'imageUrl':self.url('users/alice/videos/2.mp4')}
        self.assertEqual(self.request().status_code,409)
        self.item['imageUrl'] = self.item['videoUrl'].split('?')[0]
        self.assertEqual(self.request().status_code,200)

    def test_renewal_reauthenticates_and_rechecks_object_without_writes(self):
        self.assertEqual(self.request().status_code,200)
        self.assertEqual(self.request().status_code,200)
        self.assertEqual(self.ref.get.call_count,2)
        self.assertEqual(self.blob.reload.call_count,2)
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()


    def test_forged_library_task_id_never_authorizes_another_storage_owner(self):
        self.item.update({'taskId': 'bob-task', 'mediaType': 'video'})
        # A forged task ID does not expand access beyond Alice's actual copy.
        self.assertEqual(self.request().status_code, 200)
        self.item['videoUrl'] = self.url('users/bob/videos/output.mp4')
        self.blob.generate_signed_url.reset_mock()
        self.assertEqual(self.request().status_code, 403)
        self.blob.generate_signed_url.assert_not_called()

if __name__ == '__main__': unittest.main()
