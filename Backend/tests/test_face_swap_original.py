"""Original material authorization using real validation, offline Storage/provider."""
from datetime import timedelta
import sys
from unittest.mock import Mock, patch
import unittest
from urllib.parse import quote

from google.api_core.exceptions import NotFound
import test_face_swap_materials as materials
import test_face_swap_submission_flow as submission


class OriginalMaterialTests(unittest.TestCase):
    def setUp(self):
        materials.MaterialTests.setUp(self)
        self.blob = Mock(generation=123, content_type='image/jpeg', size=100)
        self.blob.generate_signed_url.return_value = 'https://storage.invalid/object?X-Goog-Signature=private-signature'
        self.bucket = Mock()
        self.bucket.name = 'test-bucket'
        self.bucket.blob.return_value = self.blob
        firebase = Mock(bucket=self.bucket)
        p = patch.dict(sys.modules, {'app.services.firebase': firebase})
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(materials.routes, 'prepare_original_url', submission.flow.prepare_original_url)
        p.start()
        self.addCleanup(p.stop)
        self.path = 'face-swap/alice/12345678-1234-4234-8234-123456789abc.jpg'

    login = materials.MaterialTests.login

    def url(self, path=None):
        return 'https://firebasestorage.googleapis.com/v0/b/test-bucket/o/' + quote(path or self.path, safe='') + '?alt=media&token=private-token'

    def post(self, url=None):
        return self.client.post('/swap/material', json={'image_url': url or self.url()})

    def denied(self, status, url=None):
        response = self.post(url)
        self.assertEqual(response.status_code, status)
        self.create.assert_not_awaited()
        self.ref.create.assert_not_called()
        self.blob.generate_signed_url.assert_not_called()
        self.assertNotIn('private-token', response.text)
        self.assertNotIn('private-signature', response.text)

    def test_owner_original_passes_only_version_bound_signed_url(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.material)
        self.bucket.blob.assert_called_once_with(self.path)
        self.blob.reload.assert_called_once()
        self.blob.generate_signed_url.assert_called_once_with(version='v4', expiration=timedelta(hours=1), method='GET', generation='123')
        self.create.assert_awaited_once_with(self.blob.generate_signed_url.return_value)

    def test_token_free_original_reference(self):
        self.assertEqual(self.post(self.url().split("?")[0]).status_code, 200)
        self.create.assert_awaited_once_with(self.blob.generate_signed_url.return_value)

    def test_external_foreign_and_manipulated_references(self):
        for url in [self.url().replace('test-bucket', 'other-bucket'),
                    self.url().replace('https:', 'http:'),
                    self.url().replace('googleapis.com', 'googleapis.com.evil'),
                    'https://external.invalid/image.jpg',
                    self.url(self.path.replace('/alice/', '/bob/')),
                    self.url(self.path.replace('face-swap/', 'face-swap-faces/')),
                    self.url('face-swap/alice/../bob/file.jpg'),
                    self.url('face-swap/alice/%2e%2e/file.jpg'),
                    self.url('face-swap/alice/\\file.jpg'), self.url() + '#fragment']:
            with self.subTest(url=url): self.denied(403, url)
        self.bucket.blob.assert_not_called()

    def test_missing_object(self):
        self.blob.reload.side_effect = NotFound('private-detail')
        self.denied(404)

    def test_invalid_type_size_or_version(self):
        for mime, size, version in [('image/gif',100,123), ('text/html',100,123),
                                   ('application/octet-stream',100,123), ('image/jpeg',0,123),
                                   ('image/png',10_000_001,123), ('video/mp4',1_500_000_001,123),
                                   ('image/jpeg',100,None), ('image/jpeg',100,'invalid')]:
            self.blob.content_type, self.blob.size, self.blob.generation = mime,size,version
            with self.subTest(mime=mime,size=size,version=version): self.denied(400)

    def test_supported_video_and_image_boundaries(self):
        for mime, maximum in submission.flow._ORIGINAL_LIMITS.items():
            self.blob.content_type, self.blob.size = mime, maximum
            self.assertEqual(self.post().status_code, 200)

    def test_replacement_signs_only_observed_version(self):
        def sign(**kwargs):
            self.assertEqual(kwargs['generation'], '123')
            self.blob.generation = 124  # Replacement cannot retarget the URL.
            return 'https://storage.invalid/object?generation=123'
        self.blob.generate_signed_url.side_effect = sign
        self.assertEqual(self.post().status_code, 200)
        self.create.assert_awaited_once_with('https://storage.invalid/object?generation=123')

    def test_signing_failure_has_no_external_or_financial_side_effect(self):
        self.blob.generate_signed_url.side_effect = RuntimeError('private-signature')
        response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private-signature', response.text)
        self.create.assert_not_awaited()
        self.db.collection.assert_not_called()

    def test_authentication_required_before_storage(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.post().status_code, 401)
        self.bucket.blob.assert_not_called()
