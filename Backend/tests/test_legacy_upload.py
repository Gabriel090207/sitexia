"""Offline retired-route contracts, including no body read or Storage access."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient


class LegacyUploadTests(unittest.TestCase):
    def setUp(self):
        self.storage = types.ModuleType('app.services.storage')
        self.storage.upload_image = Mock(side_effect=AssertionError('upload forbidden'))
        self.storage.bucket = Mock()
        path = Path(__file__).resolve().parents[1] / 'app/routes/upload.py'
        spec = importlib.util.spec_from_file_location('tested_legacy_upload', path)
        self.route = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'app.services.storage': self.storage}):
            spec.loader.exec_module(self.route)
        app = FastAPI()
        app.include_router(self.route.router)
        self.app = app
        self.client = TestClient(app)

    def tearDown(self):
        self.storage.upload_image.assert_not_called()
        self.storage.bucket.assert_not_called()
        self.storage.bucket.blob.assert_not_called()
        self.storage.bucket.blob.return_value.upload_from_file.assert_not_called()
        self.storage.bucket.blob.return_value.make_public.assert_not_called()

    def test_all_request_bodies_return_gone_without_validation(self):
        for kwargs in ({}, {'json': {'url': 'private-value'}},
                       {'files': {'file': ('private-name.png', b'private-file', 'image/png')}},
                       {'content': b'malformed', 'headers': {'Content-Type': 'multipart/form-data'}}):
            with self.subTest(kwargs=kwargs):
                response = self.client.post('/upload', **kwargs)
                self.assertEqual(response.status_code, 410)
                self.assertEqual(response.json(), {'detail': 'Este endpoint foi descontinuado.'})

    def test_log_is_fixed_and_has_no_request_data(self):
        with self.assertLogs(self.route.logger, level='WARNING') as logs:
            self.client.post('/upload?token=private-query', content=b'private-file',
                             headers={'Authorization': 'Bearer private-token', 'X-Forwarded-For': 'private-ip'})
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(logs.records[0].getMessage(), 'legacy_upload_endpoint_access method=POST status=410')
        self.assertNotIn('private', logs.output[0])

    def test_route_remains_registered_without_body_schema(self):
        operation = self.app.openapi()['paths']['/upload']['post']
        self.assertTrue(operation['deprecated'])
        self.assertNotIn('requestBody', operation)
        main = (Path(__file__).resolve().parents[1] / 'app/main.py').read_text()
        self.assertIn('app.include_router(upload_router)', main)

    def test_asgi_receive_is_never_called(self):
        import asyncio
        async def check():
            scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                     'method': 'POST', 'scheme': 'http', 'path': '/upload', 'raw_path': b'/upload',
                     'query_string': b'', 'root_path': '', 'headers': [],
                     'server': ('testserver', 80), 'client': ('testclient', 123)}
            messages = []
            async def receive():
                raise AssertionError('Retired endpoint must not read request body')
            async def send(message):
                messages.append(message)
            await self.app(scope, receive, send)
            self.assertEqual(messages[0]['status'], 410)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
