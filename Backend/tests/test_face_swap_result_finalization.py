"""Result-route integration with real finance primitives and offline providers."""
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

import test_face_swap_finalization as finance
import test_face_swap_submission_flow as submission
import test_face_swap_tasks as task_tests

ops = finance.operations
flow = submission.flow
routes = task_tests.routes


class ResultFinalizationTests(unittest.IsolatedAsyncioTestCase):
    reserve = finance.FinalizationTests.reserve
    acquire = finance.FinalizationTests.acquire
    link = finance.FinalizationTests.link
    finish = finance.FinalizationTests.finish

    def setUp(self):
        finance.FinalizationTests.setUp(self)
        self.result_fetch = AsyncMock(return_value={
            'taskId': self.task_id, 'taskStatus': 'SUCCEEDED',
            'imageUrls': ['https://media.invalid/result.jpg'],
        })
        for p in (patch.object(flow, 'db', ops.db),
                  patch.object(routes, 'require_task_owner'),
                  patch.object(routes, 'finalize_linked_task', side_effect=flow.finalize_linked_task),
                  patch.object(routes, 'get_deep_response', self.result_fetch)):
            p.start()
            self.addCleanup(p.stop)
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('alice', {})
        self.client = TestClient(self.app)

    def result(self):
        return self.client.post('/swap/result', json={'task_id': self.task_id})

    async def test_charged_repeated_results_only_fetch_result_without_financial_changes(self):
        await self.finish()
        self.fetch.reset_mock()
        self.fetch.side_effect = AssertionError('terminal decision must not query provider again')
        before = deepcopy(self.state)
        for _ in range(2):
            result = self.result()
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['file_url'], 'https://media.invalid/result.jpg')
        self.assertEqual(self.result_fetch.await_count, 2)
        self.fetch.assert_not_awaited()
        self.assertEqual(self.state, before)

    async def test_reserved_operation_keeps_finalization_and_frozen_cost(self):
        self.assertEqual(self.result().status_code, 200)
        self.fetch.assert_awaited_once_with(self.task_id)
        self.result_fetch.assert_awaited_once()
        self.assertEqual(self.state[self.key]['creditStatus'], 'charged')
        self.assertEqual(self.state[('users', 'alice')], {'credits': 3.0, 'reservedCredits': 0.0})

    async def test_released_operation_never_delivers_success(self):
        self.fetch.return_value['taskStatus'] = 'FAILED'
        await self.finish()
        before = deepcopy(self.state)
        self.fetch.reset_mock()
        self.assertEqual(self.result().status_code, 422)
        self.assertEqual(self.state, before)
        self.fetch.assert_not_awaited()

    async def test_invalid_terminal_links_are_rejected_before_result_fetch(self):
        await self.finish()
        original = deepcopy(self.state)
        for key, changes in (
            (self.task_key, {'submissionAttemptId': 'different'}),
            (self.task_key, {'materialId': 'different'}),
            (self.task_key, {'sourceFaceId': 'different'}),
            (self.key, {'cost': 0}),
            (self.key, {'type': 'video-generation'}),
            (self.key, {'status': 'FAILED'}),
            (self.key, {'taskLinkedAt': None}),
        ):
            with self.subTest(changes=changes):
                self.state = deepcopy(original)
                self.state[key].update(changes)
                before = deepcopy(self.state)
                self.assertEqual(self.result().status_code, 503)
                self.assertEqual(self.state, before)
        self.result_fetch.assert_not_awaited()

    async def test_other_user_is_denied(self):
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('bob', {})
        self.assertEqual(self.result().status_code, 404)
        self.result_fetch.assert_not_awaited()
        self.fetch.assert_not_awaited()

    async def test_mismatched_or_invalid_provider_id_is_rejected(self):
        await self.finish()
        before = deepcopy(self.state)
        for value in ('999', True, None, 'invalid'):
            with self.subTest(value=value):
                self.result_fetch.return_value['taskId'] = value
                self.assertEqual(self.result().status_code, 502)
        self.assertEqual(self.state, before)

    async def test_optional_provider_id_and_video_result_remain_supported(self):
        await self.finish()
        self.result_fetch.return_value = {'taskStatus': 'SUCCEEDED', 'videoUrl': 'https://media.invalid/result.mp4'}
        response = self.result()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['file_url'], 'https://media.invalid/result.mp4')

    async def test_result_timeout_after_charge_preserves_finances(self):
        await self.finish()
        before = deepcopy(self.state)
        self.fetch.reset_mock()
        self.result_fetch.side_effect = httpx.ReadTimeout('private-detail')
        response = self.result()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {'detail': 'Não foi possível consultar o resultado na Deep.'})
        self.assertEqual(self.state, before)
        self.fetch.assert_not_awaited()
        self.result_fetch.assert_awaited_once()

    async def test_conflicting_provider_state_never_delivers_result_as_success(self):
        await self.finish()
        before = deepcopy(self.state)
        for status in ('FAILED', 'UNKNOWN', 'RUNNING', None):
            self.result_fetch.return_value['taskStatus'] = status
            self.assertEqual(self.result().status_code, 502)
        self.assertEqual(self.state, before)

    async def test_legacy_unlinked_task_keeps_existing_behavior(self):
        self.state[self.task_key] = {'uid': 'alice', 'taskId': self.task_id}
        before = deepcopy(self.state)
        self.assertEqual(self.result().status_code, 200)
        self.fetch.assert_not_awaited()
        self.assertEqual(self.state, before)

    async def test_get_keeps_provider_observation_even_after_charge(self):
        await self.finish()
        self.fetch.reset_mock()
        self.fetch.return_value['taskStatus'] = 'FAILED'
        before = deepcopy(self.state[('users', 'alice')])
        response = self.client.get('/swap/task/' + self.task_id)
        self.assertEqual(response.status_code, 200)
        self.fetch.assert_awaited_once_with(self.task_id)
        self.result_fetch.assert_awaited_once()
        self.assertEqual(self.state[self.key]['lastConflictingStatus'], 'FAILED')
        self.assertEqual(self.state[('users', 'alice')], before)
