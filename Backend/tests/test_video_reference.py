"""Offline real image decoding and route contracts; no Firebase/provider I/O."""
import contextlib
from datetime import timedelta
from io import BytesIO, StringIO
import sys
import types
import unittest
from urllib.parse import quote
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.api_core.exceptions import NotFound, PreconditionFailed
from PIL import Image
import httpx

import test_image_to_video as fixtures
from app.services.video_reference import prepare_video_reference

routes = fixtures.routes
ENDPOINTS = [('image-to-video', 'image_url', 'create_image_to_video_task'),
             ('reference-to-video', 'reference_url', 'create_reference_to_video_task'),
             ('text-to-video', 'reference_image_url', 'create_text_to_video_task')]


def image_bytes(fmt='PNG', mode='RGB', size=(240, 240), **save_options):
    output = BytesIO()
    Image.new(mode, size).save(output, format=fmt, **save_options)
    return output.getvalue()


class VideoReferenceTests(unittest.TestCase):
    def setUp(self):
        self.blob = Mock(generation=123, content_type='image/png')
        self.bucket = Mock()
        self.bucket.name = 'test-bucket'
        self.bucket.blob.return_value = self.blob
        self.content = image_bytes()
        self.set_content(self.content)
        self.signed = 'https://storage.invalid/object?X-Goog-Signature=secret-signature'
        self.blob.generate_signed_url.return_value = self.signed
        self.reserve = Mock(return_value={'generationId': 'generation'})
        self.release, self.attach = Mock(), Mock()
        self.providers = {name: AsyncMock(return_value={'taskId': '123'}) for _, _, name in ENDPOINTS}
        for p in [patch.dict(sys.modules, {'app.services.firebase': types.SimpleNamespace(bucket=self.bucket)}),
                  patch.object(routes, 'prepare_video_reference', prepare_video_reference),
                  patch.object(routes, 'reserve_generation_credits', self.reserve),
                  patch.object(routes, 'release_reserved_generation', self.release),
                  patch.object(routes, 'attach_generation_task', self.attach),
                  *[patch.object(routes, name, value) for name, value in self.providers.items()]]:
            p.start()
            self.addCleanup(p.stop)
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('alice', {})
        self.client = TestClient(self.app)
        self.path = 'video-generation/alice/12345678-1234-4234-8234-123456789abc.png'

    def set_content(self, content, mime='image/png'):
        self.blob.size, self.blob.content_type = len(content), mime
        self.blob.download_as_bytes.return_value = content

    def url(self, path=None):
        return 'https://firebasestorage.googleapis.com/v0/b/test-bucket/o/' + quote(path or self.path, safe='') + '?alt=media&token=secret-token'

    def post(self, endpoint, field, url=None):
        return self.client.post('/video-generation/' + endpoint, json={field: url or self.url(), 'prompt': 'prompt', 'duration': 5})

    def assert_rejected(self, expected, url=None):
        for endpoint, field, _ in ENDPOINTS:
            with self.subTest(endpoint=endpoint):
                response = self.post(endpoint, field, url)
                self.assertEqual(response.status_code, expected, response.text)
                self.assertNotIn('secret-', response.text)
        self.reserve.assert_not_called()
        self.release.assert_not_called()
        self.attach.assert_not_called()
        for provider in self.providers.values(): provider.assert_not_awaited()

    def test_owned_reference_is_signed_before_reserving_in_all_routes(self):
        order = []
        self.blob.generate_signed_url.side_effect = lambda **kwargs: order.append('sign') or self.signed
        self.reserve.side_effect = lambda *args: order.append('reserve') or {'generationId': 'generation'}
        for endpoint, field, name in ENDPOINTS:
            order.clear()
            self.assertEqual(self.post(endpoint, field).status_code, 200)
            self.assertEqual(order, ['sign', 'reserve'])
            self.assertIn(self.signed, self.providers[name].call_args.args)
            self.assertNotIn(self.url(), self.providers[name].call_args.args)
        self.blob.generate_signed_url.assert_called_with(version='v4', expiration=timedelta(hours=1), method='GET', generation='123')
        self.blob.download_as_bytes.assert_called_with(start=0, end=20_000_000, if_generation_match=123, raw_download=True)
        self.bucket.blob.assert_called_with(self.path)

    def test_token_free_references_in_all_routes(self):
        for endpoint, field, name in ENDPOINTS:
            self.assertEqual(self.post(endpoint, field, self.url().split("?")[0]).status_code, 200)
            self.assertIn(self.signed, self.providers[name].call_args.args)

    def test_text_reference_can_be_omitted_or_empty(self):
        for body in ({'prompt': 'prompt', 'duration': 5}, {'prompt': 'prompt', 'duration': 5, 'reference_image_url': ''}):
            self.assertEqual(self.client.post('/video-generation/text-to-video', json=body).status_code, 200)
        self.bucket.blob.assert_not_called()
        self.assertEqual(self.providers['create_text_to_video_task'].call_args.args, ('prompt', '', 5))

    def test_unauthenticated(self):
        self.app.dependency_overrides.clear()
        self.assert_rejected(401)
        self.bucket.blob.assert_not_called()

    def test_foreign_external_and_manipulated_objects(self):
        for url in [self.url().replace('test-bucket', 'other-bucket'),
                    self.url(self.path.replace('/alice/', '/bob/')),
                    self.url().replace('https:', 'http:'),
                    self.url().replace('googleapis.com', 'googleapis.com.evil'),
                    'https://external.invalid/image.png', self.url() + '#fragment',
                    self.url('video-generation/alice/../bob/image.png'),
                    self.url('video-generation/alice/%2e%2e/image.png'),
                    self.url('video-generation/alice/\\image.png'),
                    self.url(self.path.replace('video-generation/', 'face-swap/'))]:
            with self.subTest(url=url): self.assert_rejected(403, url)
        self.bucket.blob.assert_not_called()

    def test_missing_object_or_unavailable_metadata(self):
        for error, status in [(NotFound('secret-token'),404), (RuntimeError('secret-token'),503)]:
            self.blob.reload.side_effect = error
            self.assert_rejected(status)
        self.blob.download_as_bytes.assert_not_called()

    def test_invalid_metadata(self):
        for field, value in [('size',0), ('size',20_000_001), ('content_type','image/gif'), ('content_type','application/octet-stream'), ('generation',None)]:
            old = getattr(self.blob, field)
            setattr(self.blob, field, value)
            self.assert_rejected(400)
            setattr(self.blob, field, old)
        self.blob.download_as_bytes.assert_not_called()

    def test_invalid_content_mime_dimensions_and_png_transparency(self):
        for content, mime in [(b'not an image','image/png'), (image_bytes('GIF'),'image/png'),
                              (image_bytes('JPEG'),'image/png'), (image_bytes(mode='RGBA'),'image/png'),
                              (image_bytes(mode='P',transparency=0),'image/png')]:
            self.set_content(content,mime)
            self.assert_rejected(400)
        for size in [(239,240),(240,239),(8001,240),(240,8001)]:
            self.set_content(image_bytes(size=size))
            for endpoint, field, _ in ENDPOINTS[:2]:
                self.assertEqual(self.post(endpoint, field).status_code,400)
        self.reserve.assert_not_called()

    def test_dimensions_are_not_imposed_on_text_mode(self):
        self.set_content(image_bytes(size=(9000,240)))
        self.assertEqual(self.post('text-to-video','reference_image_url').status_code,200)

    def test_jpeg_png_webp_real_content_accepted(self):
        for fmt,mime in [('JPEG','image/jpeg'),('PNG','image/png'),('WEBP','image/webp')]:
            self.set_content(image_bytes(fmt),mime)
            self.assertEqual(self.post('image-to-video','image_url').status_code,200)

    def test_download_replacement_and_failure(self):
        for error, status in [(PreconditionFailed('secret-signature'),409), (NotFound('secret-signature'),409), (RuntimeError('secret-token'),503)]:
            self.blob.download_as_bytes.side_effect = error
            self.assert_rejected(status)
        self.blob.generate_signed_url.assert_not_called()

    def test_size_mismatch_or_signing_failure(self):
        self.blob.size += 1
        self.assert_rejected(400)
        self.blob.size -= 1
        self.blob.generate_signed_url.side_effect = RuntimeError('secret-signature')
        self.assert_rejected(503)

    def test_signed_generation_does_not_follow_replacement(self):
        def download(**kwargs):
            self.assertEqual(kwargs['if_generation_match'],123)
            self.blob.generation = 124
            return self.content
        self.blob.download_as_bytes.side_effect = download
        self.assertEqual(self.post('image-to-video','image_url').status_code,200)
        self.assertEqual(self.blob.generate_signed_url.call_args.kwargs['generation'],'123')

    def test_provider_exception_details_are_not_logged_or_returned(self):
        for provider in self.providers.values():
            provider.side_effect = RuntimeError('secret-token secret-signature private-result-url')
        with self.assertLogs(routes.logger,level='WARNING') as logs:
            for endpoint,field,_ in ENDPOINTS:
                response = self.post(endpoint,field)
                self.assertEqual(response.status_code,502)
                self.assertNotIn('secret', response.text)
        self.assertNotIn('secret', ' '.join(logs.output))
        self.assertNotIn('private-result-url', ' '.join(logs.output))
        self.release.assert_not_called()  # Ambiguous sends remain reserved.


class VideoProviderLoggingTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_video_creation_payloads_and_polling_hide_urls(self):
        provider = fixtures.provider
        client = AsyncMock()
        response = httpx.Response(200,json={'taskId':'123','videoUrl':'https://private-result.invalid/secret'},
                                  request=httpx.Request('POST','https://provider.invalid'))
        client.post.return_value = response
        client.get.return_value = response
        output = StringIO()
        with patch.object(provider,'_sign',return_value=({},'secret-signature secret-token')), \
             patch.object(provider.httpx,'AsyncClient') as factory, self.assertLogs(provider.logger, level='INFO') as captured:
            factory.return_value.__aenter__.return_value = client
            await provider.create_image_to_video_task('secret-token','prompt',5)
            await provider.create_reference_to_video_task('secret-token','prompt',5)
            await provider.create_text_to_video_task('prompt','secret-token',5)
            await provider.get_video_task('123')
        self.assertIn('200',' '.join(captured.output))
        for secret in ('secret-token','secret-signature','private-result'):
            self.assertNotIn(secret,' '.join(captured.output))
