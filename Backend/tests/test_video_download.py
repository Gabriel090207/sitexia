"""Real download route + signing service, offline Firestore/Storage primitives."""
import contextlib
import io
import types
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from google.api_core.exceptions import NotFound
import test_video_access as fixtures


class VideoDownloadTests(unittest.TestCase):
    url = staticmethod(fixtures.VideoAccessTests.url)

    def setUp(self):
        fixtures.VideoAccessTests.setUp(self)
        with patch.dict(fixtures.sys.modules, {
            'app.services.firebase': types.SimpleNamespace(db=self.db, bucket=self.bucket),
            'app.services.video_access': fixtures.service,
        }):
            self.route = fixtures.load('tested_video_download', 'app/routes/download.py')
        app = FastAPI()
        app.include_router(self.route.router)
        app.dependency_overrides[self.route.get_current_user] = lambda: self.route.AuthenticatedUser('alice', {})
        self.app, self.http = app, TestClient(app)

    def request(self, uid='alice', direct=True):
        return self.http.get(f'/download/{uid}/item', params={'delivery':'direct'} if direct else {}, follow_redirects=False)

    def test_face_swap_video_mime_extension_and_attachment_are_validated(self):
        for mime, extension in [('video/mp4','mp4'), ('video/webm','webm'), ('video/quicktime','mov')]:
            self.item = {'type':'face-swap', 'mediaType':'video', 'videoUrl':self.url('users/alice/swaps/not-an-extension.png')}
            self.blob.content_type = mime
            response = self.request()
            self.assertEqual(response.status_code,200,response.text)
            access = response.json()
            self.assertEqual(access['contentType'],mime)
            self.assertTrue(access['filename'].endswith('.'+extension))
            self.assertTrue(access['filename'].startswith('xia-face-swap-'))
            args = self.blob.generate_signed_url.call_args.kwargs
            self.assertEqual(args['response_type'],mime)
            self.assertEqual(args['response_disposition'],f'attachment; filename="{access["filename"]}"')
            self.assertEqual(args['generation'],'123')
            self.assertEqual(args['method'],'GET')
            self.assertNotIn('headers',args)
            self.assertEqual(response.headers['cache-control'],'private, no-store')
        self.blob.download_as_bytes.assert_not_called()

    def test_video_generation_and_default_get_remain_downloadable_without_buffering(self):
        response = self.request()
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json()['filename'].startswith('xia-video-generation-'))
        redirect = self.request(direct=False)
        self.assertEqual(redirect.status_code,303)
        self.assertEqual(redirect.headers['location'],self.signed)
        self.blob.download_as_bytes.assert_not_called()

    def test_legacy_face_swap_video_in_image_url_and_old_token(self):
        for token in (True,False):
            self.item = {'imageUrl':self.url('users/alice/swaps/old-file',token)}
            response = self.request()
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['mediaType'],'video')
            self.assertNotIn('private-token',response.text)
        self.blob.download_as_bytes.assert_not_called()

    def test_unknown_mime_is_not_guessed_to_be_video(self):
        self.item = {'imageUrl':self.url('users/alice/swaps/file.mp4')}
        self.blob.content_type = 'application/octet-stream'
        self.assertEqual(self.request().status_code,415)
        self.blob.generate_signed_url.assert_not_called()
        self.blob.download_as_bytes.assert_not_called()

    def test_image_downloads_preserve_existing_contract(self):
        self.blob.content_type = 'image/png'
        self.blob.download_as_bytes.return_value = b'image'
        for kind,folder in [('face-swap','swaps'), ('image-generation','images/batch/0')]:
            self.item = {'type':kind,'imageUrl':self.url(f'users/alice/{folder}/image.png')}
            response = self.request()
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.content,b'image')
            self.assertEqual(response.headers['content-type'],'image/png')
            self.assertIn('attachment;',response.headers['content-disposition'])
        self.blob.generate_signed_url.assert_not_called()

    def test_authentication_and_owner_checks_precede_lookup(self):
        self.assertEqual(self.request(uid='bob').status_code,403)
        self.app.dependency_overrides.clear()
        self.assertEqual(self.request().status_code,401)
        with patch('app.dependencies.auth.auth.verify_id_token',side_effect=ValueError('private-token')):
            response = self.http.get('/download/alice/item',headers={'Authorization':'Bearer invalid'})
        self.assertEqual(response.status_code,401)
        self.db.collection.assert_not_called()

    def test_foreign_bucket_owner_and_manipulated_references(self):
        for value in [self.url('users/bob/videos/file.mp4'), self.url('users/alice/videos/../bob/file.mp4'),
                      self.url('users/alice/videos/%2e%2e/file.mp4'), 'https://external.invalid/file.mp4',
                      self.url('users/alice/videos/file.mp4').replace('demo-bucket','other-bucket')]:
            self.item = {'type':'face-swap','videoUrl':value,'mediaType':'video'}
            self.assertEqual(self.request().status_code,403)
        self.bucket.blob.assert_not_called()

    def test_missing_object_access_error_and_signing_error_are_controlled(self):
        for error,expected in [(NotFound('private-token'),404),(RuntimeError('private-token'),503)]:
            self.blob.reload.side_effect = error
            response = self.request()
            self.assertEqual(response.status_code,expected)
            self.assertNotIn('private-token',response.text)
        self.blob.reload.side_effect = None
        self.blob.generate_signed_url.side_effect = RuntimeError('private-signature private-token')
        with self.assertLogs(fixtures.service.logger,level='WARNING') as logs:
            response = self.request()
        self.assertEqual(response.status_code,503)
        self.assertNotIn('private-signature',' '.join(logs.output))
        self.assertNotIn('private-token',response.text)

    def test_success_does_not_print_signed_urls_and_never_buffers_large_video(self):
        self.blob.size = 1_500_000_000
        output = io.StringIO()
        with contextlib.redirect_stdout(output),contextlib.redirect_stderr(output):
            self.assertEqual(self.request().status_code,200)
        self.assertNotIn('private-signature',output.getvalue())
        self.blob.download_as_bytes.assert_not_called()
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()
