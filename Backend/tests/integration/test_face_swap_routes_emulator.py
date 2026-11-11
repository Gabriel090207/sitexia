"""Real FastAPI routes + Firestore Emulator; DeepSwap and signed Storage are mocked.

Run with the same loopback guard/demo project as test_face_swap_emulator.
No production credentials or .env are loaded.
"""
import importlib
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import httpx
import test_face_swap_emulator as base

fake_provider = types.ModuleType('app.services.deepswap')
for name in ('create_material', 'get_material', 'create_task', 'get_task', 'get'):
    setattr(fake_provider, name, AsyncMock())
with patch.dict(base.sys.modules, {'app.services.deepswap': fake_provider}):
    routes = importlib.import_module('app.routes.swap')
    flow = importlib.import_module('app.services.face_swap_submission')


class RouteFinanceTests(unittest.TestCase):
    def setUp(self):
        base.EmulatorFinanceTests.setUp(self)
        self.material_ref = base.client.collection('face_swap_materials').document('123')
        self.material_ref.set({'uid': self.uid, 'materialId': '123'})
        self.task = self.task_id()
        self.provider_response = {'taskId': self.task, 'taskStatus': 'PENDING'}
        self.create = AsyncMock(return_value=self.provider_response)
        self.blob = Mock()
        self.blob.generate_signed_url.return_value = 'https://storage.invalid/signed'
        self.metadata = {'materialId': '123', 'status': 'SUCCEEDED', 'materialType': 'VIDEO',
                         'duration': 16, 'faces': [{'id': '5'}]}
        for p in (
            patch.object(flow, 'authorize_target', return_value=('object@version', self.blob, '1')),
            patch.object(routes, 'get_material', AsyncMock(return_value=self.metadata)),
            patch.object(routes, 'create_task', self.create),
            patch.object(routes, 'get_deep_response', AsyncMock(side_effect=lambda *a, **k: dict(self.provider_response))),
            patch.object(base.ops, '_fetch_face_swap_task', AsyncMock(side_effect=lambda *a: dict(self.provider_response))),
        ):
            p.start()
            self.addCleanup(p.stop)
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser(self.uid, {})
        self.http = TestClient(app)

    def tearDown(self):
        self.material_ref.delete()
        base.EmulatorFinanceTests.tearDown(self)

    task_id = base.EmulatorFinanceTests.task_id
    balances = base.EmulatorFinanceTests.balances
    parallel = base.EmulatorFinanceTests.parallel

    def submit(self, key='intent-1', **changes):
        body = {'material_id': '123', 'source_face_id': '5', 'target_face_url': 'client-url',
                'media_type': 'image', 'video_duration': 0.01}
        body.update(changes)
        return self.http.post('/swap/task', json=body,
                              headers={} if key is None else {'Idempotency-Key': key})

    def test_route_reserves_trusted_price_replay_status_charges_once(self):
        self.assertEqual(self.submit().status_code, 200)
        self.balances(5, 2)
        self.assertEqual(self.submit(media_type='video', video_duration=999).status_code, 200)
        self.create.assert_awaited_once()
        self.provider_response.update(taskStatus='SUCCEEDED', videoUrl='https://media.invalid/result.mp4')
        for _ in range(2):
            self.assertEqual(self.http.get('/swap/task/' + self.task).status_code, 200)
        self.balances(3, 0)
        self.assertEqual(self.http.post('/swap/result', json={'task_id': self.task}).status_code, 200)
        self.balances(3, 0)

    def test_failed_task_releases_once(self):
        self.assertEqual(self.submit().status_code, 200)
        self.provider_response['taskStatus'] = 'FAILED'
        for _ in range(2):
            self.assertEqual(self.http.get('/swap/task/' + self.task).status_code, 200)
        self.balances(5, 0)

    def test_missing_key_and_conflicting_key_are_rejected(self):
        self.assertEqual(self.submit(key=None).status_code, 422)
        self.create.assert_not_awaited()
        self.assertEqual(self.submit().status_code, 200)
        self.assertEqual(self.submit(source_face_id='6').status_code, 409)
        self.create.assert_awaited_once()
        self.balances(5, 2)

    def test_unauthorized_target_prevents_reservation(self):
        with patch.object(flow, 'authorize_target', side_effect=HTTPException(403, 'Arquivo de rosto não autorizado.')):
            self.assertEqual(self.submit().status_code, 403)
        self.create.assert_not_awaited()
        self.balances(5, 0)

    def test_timeout_and_replay_do_not_release_or_resend(self):
        self.create.side_effect = httpx.ReadTimeout('private')
        self.assertEqual(self.submit().status_code, 502)
        self.assertEqual(self.submit().status_code, 409)
        self.create.assert_awaited_once()
        self.balances(5, 2)

    def test_failed_binding_preserves_operation(self):
        with patch.object(base.ops, 'link_face_swap_task', side_effect=RuntimeError('storage error')):
            self.assertEqual(self.submit().status_code, 503)
        self.assertEqual(self.submit().status_code, 409)
        self.create.assert_awaited_once()
        self.balances(5, 2)

    def test_legacy_debit_not_charged_again(self):
        base.client.collection('face_swap_tasks').document(self.task).set({'uid': self.uid, 'taskId': self.task})
        self.provider_response['taskStatus'] = 'SUCCEEDED'
        self.assertEqual(self.http.get('/swap/task/' + self.task).status_code, 200)
        self.balances(5, 0)

    def test_concurrent_route_calls_cannot_duplicate_external_creation(self):
        responses = self.parallel(lambda _: self.submit())
        self.assertTrue(all(r.status_code in (200, 409, 503) for r in responses))
        # Under emulator lock exhaustion both calls may safely fail with 503.
        # Completion is not guaranteed by concurrency; financial safety is.
        self.assertLessEqual(self.create.await_count, 1)
        records = list(base.client.collection('generations').where(
            filter=base.FieldFilter('userId', '==', self.uid)).stream())
        self.assertLessEqual(len(records), 1)
        self.balances(5, 2 if records else 0)
        # An explicit client replay with the SAME key can recover CREATED or
        # linked state. It must never obtain a second provider send grant.
        replay = self.submit()
        self.assertIn(replay.status_code, (200, 409, 503))
        self.assertLessEqual(self.create.await_count, 1)

    def test_image_reserve_untouched_by_route_finalization(self):
        record = base.credits.reserve_generation_credits(self.uid, 'image', 0.2, 'image-generation', 'text-to-image')
        ref = base.client.collection('generations').document(record['generationId'])
        before = ref.get().to_dict()
        self.assertEqual(self.submit().status_code, 200)
        self.provider_response['taskStatus'] = 'SUCCEEDED'
        self.assertEqual(self.http.get('/swap/task/' + self.task).status_code, 200)
        self.assertEqual(ref.get().to_dict(), before)
        self.assertEqual(self.user.get().to_dict()['credits'], 3)
        self.assertAlmostEqual(self.user.get().to_dict()['reservedCredits'], 0.2)


if __name__ == '__main__':
    unittest.main()
