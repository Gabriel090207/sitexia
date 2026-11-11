"""Offline provider logging: real httpx serialization with MockTransport only."""
import importlib.util
import io
import json
import logging
from pathlib import Path
import traceback
import unittest
from unittest.mock import patch

import httpx

with patch('dotenv.load_dotenv'):
    spec = importlib.util.spec_from_file_location('private_logging_provider', Path(__file__).parents[1] / 'app/services/deepswap.py')
    provider = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(provider)

SECRET = 'SENSITIVE_SENTINEL'
PRIVATE_URL = f'https://private.invalid/file?token={SECRET}&X-Goog-Signature={SECRET}'

class LoggingTests(unittest.IsolatedAsyncioTestCase):
    async def request(self, method='GET', status=200, result=None, error=None, uri='/openapi/v1/tasks/123', raw=None):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root = logging.getLogger()
        previous = root.level
        root.setLevel(logging.DEBUG)
        root.addHandler(handler)
        original_client = httpx.AsyncClient
        requests = []
        def respond(request):
            requests.append(request)
            # Simulate DEBUG transport diagnostics with headers and error details.
            logging.getLogger('httpcore.http11').debug('headers=%s', SECRET)
            if error:
                raise error
            return httpx.Response(status, json=result, content=raw) if raw is None else httpx.Response(status, content=raw)
        try:
            with patch.object(provider, 'BASE_URL', 'https://provider.invalid'), \
                 patch.object(provider, 'ACCESS_KEY', SECRET), patch.object(provider, 'SECRET_KEY', SECRET), \
                 patch.object(provider.httpx, 'AsyncClient', side_effect=lambda: original_client(transport=httpx.MockTransport(respond))):
                try:
                    value = await (provider.post(uri, {'prompt': SECRET, 'url': PRIVATE_URL}) if method == 'POST'
                                   else provider.get(uri, query=f'private={SECRET}'))
                except Exception as exc:
                    # An outer logger logging the traceback must also remain safe.
                    logging.getLogger('outer').error('provider failure', exc_info=True)
                    value = exc
            output = stream.getvalue()
            self.assertNotIn(SECRET, output)
            self.assertNotIn('private.invalid', output)
            self.assertNotIn('X-Goog-Signature', output)
            self.assertNotIn('provider.invalid', output)
            self.assertIn('operation=', output)
            self.assertIn('duration_ms=', output)
            return value, output, requests
        finally:
            root.removeHandler(handler)
            root.setLevel(previous)

    async def test_creation_operations_preserve_bodies_and_returns(self):
        for uri, category in [('/openapi/v1/aigc/image-generation/tasks', 'image_creation'),
                              ('/openapi/v1/aigc/video-generation/tasks', 'video_creation'),
                              ('/openapi/v1/face-swap/materials', 'material_creation'),
                              ('/openapi/v1/face-swap/tasks', 'face_swap_creation')]:
            with self.subTest(uri=uri):
                result = {'taskId': '123', 'private': PRIVATE_URL}
                value, logs, requests = await self.request(method='POST', uri=uri, result=result)
                self.assertEqual(value, result)
                self.assertEqual(json.loads(requests[0].content), {'prompt': SECRET, 'url': PRIVATE_URL})
                self.assertEqual(requests[0].headers['X_API_KEY'], SECRET)
                self.assertIn(category, logs)
                self.assertIn('http_status=200', logs)

    async def test_task_results_and_states_unchanged(self):
        for state in ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', SECRET]:
            for field in ['imageUrls', 'videoUrl']:
                result = {'taskStatus': state, field: [PRIVATE_URL] if field == 'imageUrls' else PRIVATE_URL, 'errorMsg': SECRET}
                value, logs, _ = await self.request(result=result)
                self.assertEqual(value, result)
                self.assertIn('task_status=' + (state if state != SECRET else 'UNSPECIFIED'), logs)

    async def test_http_errors_keep_status_response_and_safe_traceback(self):
        for status in [400, 401, 403, 429, 500]:
            with self.subTest(status=status):
                value, logs, _ = await self.request(status=status, result={'error': SECRET, 'imageUrls': [PRIVATE_URL]})
                self.assertIsInstance(value, httpx.HTTPStatusError)
                self.assertEqual(value.response.status_code, status)
                self.assertEqual(value.response.json()['error'], SECRET)
                self.assertIn(f'http_status={status}', logs)
                self.assertIn('error_category=http', logs)

    async def test_network_timeout_and_unexpected_error(self):
        for error, category in [(httpx.ReadTimeout(PRIVATE_URL), 'timeout'),
                                (httpx.ConnectError(PRIVATE_URL), 'network'), (RuntimeError(PRIVATE_URL), 'unexpected')]:
            value, logs, _ = await self.request(error=error)
            self.assertIsInstance(value, Exception)
            self.assertIn('error_category=' + category, logs)
            if isinstance(error, httpx.RequestError):
                self.assertIsInstance(value, type(error))

    async def test_invalid_json_does_not_log_document(self):
        value, logs, _ = await self.request(raw=SECRET.encode())
        self.assertIsInstance(value, json.JSONDecodeError)
        self.assertEqual(value.doc, '')
        self.assertIn('invalid_response', logs)

    async def test_transport_filter_is_scoped_to_provider_calls(self):
        await self.request(result={})
        self.assertFalse(provider._transport_private.get())
        record = logging.LogRecord('httpx', logging.INFO, '', 0, 'unrelated', (), None)
        self.assertTrue(provider._PrivateTransportLogs().filter(record))

    async def test_unknown_endpoint_is_not_logged_verbatim(self):
        _, logs, _ = await self.request(uri='/unknown/' + SECRET, result={})
        self.assertIn('operation=provider_request', logs)
