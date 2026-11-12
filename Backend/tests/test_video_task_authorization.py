"""Actual ownership lookup + routes; offline two-user Firestore/provider fixtures."""
import unittest
from unittest.mock import Mock, AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import test_image_to_video as fixtures
import test_face_swap_operations as financial

routes = fixtures.routes


class VideoTaskAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.uid = 'alice'
        self.records = {
            'alice-task': {'userId': 'alice', 'type': 'video-generation'},
            'bob-task': {'userId': 'bob', 'type': 'video-generation'},
            'image-task': {'userId': 'alice', 'type': 'image-generation'},
        }
        db = Mock()
        def collection(name):
            self.assertEqual(name, 'generations', 'Library fields must never authorize provider tasks')
            query = Mock()
            def where(*, filter):
                self.assertEqual(filter.field_path, 'taskId')
                data = self.records.get(filter.value)
                query.limit.return_value.stream.return_value = [] if data is None else [Mock(id='generation-' + filter.value, to_dict=lambda: data)]
                return query
            query.where.side_effect = where
            return query
        db.collection.side_effect = collection
        for p in [patch.object(financial.credits, 'db', db),
                  patch.object(routes, 'get_generation_by_task_for_user', financial.credits.get_generation_by_task_for_user)]:
            p.start(); self.addCleanup(p.stop)
        self.reserve = Mock(return_value={'generationId': 'new-generation'})
        self.attach, self.charge, self.release = Mock(), Mock(), Mock()
        self.create = AsyncMock(return_value={'taskId': 'extended-task'})
        self.get = AsyncMock(return_value={'taskStatus': 'SUCCEEDED', 'videoUrl': 'private-provider-result'})
        for name, value in [('reserve_generation_credits', self.reserve), ('attach_generation_task', self.attach),
                            ('charge_reserved_generation', self.charge), ('release_reserved_generation', self.release),
                            ('create_video_extend_task', self.create), ('get_video_task', self.get)]:
            p = patch.object(routes, name, value); p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser(self.uid, {})
        self.app, self.http = app, TestClient(app)

    def extend(self, task):
        return self.http.post('/video-generation/extend', json={'source_task_id': task, 'prompt': 'synthetic', 'duration': 5})

    def test_own_bound_task_query_and_extension_preserve_contract(self):
        result = self.http.get('/video-generation/task/alice-task')
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['videoUrl'], 'private-provider-result')
        self.charge.assert_called_once_with('generation-alice-task')
        result = self.extend('alice-task')
        self.assertEqual(result.status_code, 200, result.text)
        self.create.assert_awaited_once_with('alice-task', 'synthetic', 5)
        self.reserve.assert_called_once()
        self.attach.assert_called_once_with('new-generation', 'extended-task')

    def test_foreign_task_rejected_even_if_library_contains_forged_task_id(self):
        # Actual lookup reads only backend generations, regardless of any library copy.
        for task in ['bob-task', 'unbound-legacy', 'image-task']:
            for response in [self.http.get('/video-generation/task/' + task), self.extend(task)]:
                self.assertEqual(response.status_code, 404, response.text)
                self.assertNotIn('private-provider-result', response.text)
            self.get.assert_not_awaited(); self.create.assert_not_awaited()
            self.reserve.assert_not_called(); self.charge.assert_not_called(); self.release.assert_not_called()

    def test_bob_can_use_own_task_but_not_alice_task(self):
        self.uid = 'bob'
        self.assertEqual(self.extend('alice-task').status_code, 404)
        self.reserve.assert_not_called()
        self.assertEqual(self.extend('bob-task').status_code, 200)
        self.create.assert_awaited_once_with('bob-task', 'synthetic', 5)

    def test_missing_or_invalid_auth_stops_before_finance_and_provider(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.extend('alice-task').status_code, 401)
        with patch('app.dependencies.auth.auth.verify_id_token', side_effect=ValueError('private')):
            result = self.http.get('/video-generation/task/alice-task', headers={'Authorization': 'Bearer invalid'})
        self.assertEqual(result.status_code, 401)
        self.reserve.assert_not_called(); self.get.assert_not_awaited(); self.create.assert_not_awaited()

    def test_ownership_lookup_failure_does_not_send_or_reserve(self):
        with patch.object(routes, 'get_generation_by_task_for_user', side_effect=RuntimeError('private-url')):
            response = self.extend('alice-task')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private-url', response.text)
        self.reserve.assert_not_called(); self.create.assert_not_awaited()

    def test_library_only_legacy_task_is_denied_even_when_owned_copy_exists(self):
        # An owned saved object authorizes playback/download, not provider task access.
        self.assertEqual(self.http.get('/video-generation/task/legacy-saved-copy').status_code, 404)
        self.assertEqual(self.extend('legacy-saved-copy').status_code, 404)
        self.reserve.assert_not_called(); self.get.assert_not_awaited(); self.create.assert_not_awaited()
