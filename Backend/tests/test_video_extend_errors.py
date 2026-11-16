"""Real extension route and financial orchestration, synthetic state/provider only."""
import ast
import json
from pathlib import Path
import unittest

import httpx
from fastapi.middleware.cors import CORSMiddleware
import test_video_task_authorization as fixtures

routes = fixtures.routes
PRIVATE = 'private-prompt-token-signature'


class ExtendErrorTests(unittest.TestCase):
    def setUp(self):
        fixtures.VideoTaskAuthorizationTests.setUp(self)
        # Use the versioned application's exact CORS configuration without importing
        # its Firebase initialization or any real credentials.
        tree = ast.parse((Path(__file__).parents[1] / 'app/main.py').read_text())
        cors = next(node for node in ast.walk(tree) if isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute) and node.func.attr == 'add_middleware'
                    and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == 'CORSMiddleware')
        self.app.add_middleware(CORSMiddleware, **{kw.arg: ast.literal_eval(kw.value) for kw in cors.keywords})
        self.state = {'credits': 5.0, 'reserved': 0.0, 'status': None}
        def reserve(*args):
            self.state.update(reserved=args[2], status='reserved')
            return {'generationId': 'new-generation'}
        def release(_identifier):
            self.state.update(reserved=0.0, status='released')
        self.reserve.side_effect = reserve
        self.release.side_effect = release

    def request(self):
        return self.http.post('/video-generation/extend', json={
            'source_task_id': '123', 'prompt': 'synthetic', 'duration': 5,
        }, headers={'Origin': 'http://localhost:5173'})

    def safe_response(self, response, status):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.headers.get('access-control-allow-origin'), 'http://localhost:5173')
        self.assertEqual(response.headers.get('access-control-allow-credentials'), 'true')
        self.assertIsInstance(response.json()['detail'], str)
        self.assertNotIn(PRIVATE, response.text)
        self.assertNotIn('https://', response.text)
        self.reserve.assert_called_once()
        self.create.assert_awaited_once()
        self.charge.assert_not_called()
        self.assertEqual(self.state['credits'], 5.0)

    def provider_error(self, status):
        request = httpx.Request('POST', 'https://provider.invalid/' + PRIVATE,
                                headers={'Authorization': 'Bearer ' + PRIVATE})
        response = httpx.Response(status, request=request, json={'detail': PRIVATE})
        return httpx.HTTPStatusError(PRIVATE, request=request, response=response)

    def rejection(self, status):
        self.create.side_effect = self.provider_error(status)
        with self.assertLogs(routes.logger, level='WARNING') as logs:
            response = self.request()
        self.safe_response(response, 502)
        self.release.assert_called_once_with('new-generation')
        self.attach.assert_not_called()
        self.assertEqual(self.state['status'], 'released')
        self.assertEqual(self.state['reserved'], 0.0)
        self.assertNotIn(PRIVATE, '\n'.join(logs.output))
        self.assertNotIn('devolv', response.text.lower())

    def ambiguous(self, error):
        self.create.side_effect = error
        with self.assertLogs(routes.logger, level='WARNING') as logs:
            response = self.request()
        self.safe_response(response, 502)
        self.release.assert_not_called()
        self.attach.assert_not_called()
        self.assertEqual(self.state['status'], 'reserved')
        self.assertEqual(self.state['reserved'], 1.2)
        self.assertIn('Não inicie outra extensão', response.json()['detail'])
        self.assertNotIn(PRIVATE, '\n'.join(logs.output))

    def test_400_releases_once_and_returns_controlled_response_with_cors(self): self.rejection(400)
    def test_415_releases_once_and_returns_controlled_response_with_cors(self): self.rejection(415)
    def test_422_releases_once_and_returns_controlled_response_with_cors(self): self.rejection(422)
    def test_408_preserves_reserve_with_cors(self): self.ambiguous(self.provider_error(408))
    def test_500_preserves_reserve_with_cors(self): self.ambiguous(self.provider_error(500))
    def test_503_preserves_reserve_with_cors(self): self.ambiguous(self.provider_error(503))
    def test_timeout_preserves_reserve_with_cors(self): self.ambiguous(httpx.ReadTimeout(PRIVATE))
    def test_network_failure_preserves_reserve_with_cors(self): self.ambiguous(httpx.ConnectError(PRIVATE))
    def test_invalid_provider_json_preserves_reserve(self): self.ambiguous(json.JSONDecodeError(PRIVATE, '', 0))

    def test_release_failure_is_explicit_without_claiming_a_refund(self):
        self.create.side_effect = self.provider_error(400)
        self.release.side_effect = RuntimeError(PRIVATE)
        with self.assertLogs(routes.logger, level='WARNING') as logs:
            response = self.request()
        self.safe_response(response, 503)
        self.assertIn('não foi possível confirmar a liberação', response.json()['detail'])
        self.assertIn('release_unconfirmed', '\n'.join(logs.output))
        self.assertNotIn(PRIVATE, '\n'.join(logs.output))
        self.release.assert_called_once()
        self.assertEqual(self.state['status'], 'reserved')
        self.assertEqual(self.state['reserved'], 1.2)
        self.attach.assert_not_called()

    def test_lost_release_reply_does_not_claim_known_financial_state_or_retry(self):
        self.create.side_effect = self.provider_error(400)
        def release(_identifier):
            self.state.update(reserved=0.0, status='released')
            raise RuntimeError(PRIVATE)
        self.release.side_effect = release
        response = self.request()
        self.safe_response(response, 503)
        self.assertIn('não foi possível confirmar a liberação', response.json()['detail'])
        self.release.assert_called_once()
        self.assertEqual(self.state['status'], 'released')

    def test_binding_failure_does_not_release_or_resubmit(self):
        self.attach.side_effect = RuntimeError(PRIVATE)
        response = self.request()
        self.safe_response(response, 503)
        self.attach.assert_called_once_with('new-generation', 'extended-task')
        self.release.assert_not_called()
        self.assertEqual(self.state['status'], 'reserved')
        self.assertIn('A tarefa ou reserva pode existir', response.json()['detail'])

    def test_reservation_storage_failure_never_sends_a_provider_request(self):
        self.reserve.side_effect = RuntimeError(PRIVATE)
        response = self.request()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers.get('access-control-allow-origin'), 'http://localhost:5173')
        self.assertNotIn(PRIVATE, response.text)
        self.create.assert_not_awaited()
        self.release.assert_not_called()
        self.charge.assert_not_called()
        self.assertEqual(self.state, {'credits': 5.0, 'reserved': 0.0, 'status': None})
