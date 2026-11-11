"""Submission orchestration with real finance primitives, offline storage/provider."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
import types
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import HTTPException
import test_face_swap_finalization as financial

fixtures = financial.fixtures
ops = financial.operations
with patch.dict(fixtures.helpers.sys.modules, {
    'app.services.firebase': fixtures.helpers.firebase,
    'app.services.face_swap_operations': ops,
    'app.services.generation_credits': fixtures.credits,
    'app.services.face_swap_pricing': types.SimpleNamespace(
        InvalidFaceSwapMetadata=ops.calculate_face_swap_price.__globals__['InvalidFaceSwapMetadata']),
}):
    flow = fixtures.helpers.load('tested_swap_submission_flow', 'app/services/face_swap_submission.py')


class SubmissionFlowTests(unittest.IsolatedAsyncioTestCase):
    reserve = financial.FinalizationTests.reserve
    acquire = financial.FinalizationTests.acquire
    link = financial.FinalizationTests.link

    def setUp(self):
        financial.FinalizationTests.setUp(self)
        self.state = {('users', 'alice'): {'credits': 5.0, 'reservedCredits': 0.0}}
        self.blob = Mock()
        self.blob.generate_signed_url.return_value = 'https://storage.invalid/signed'
        self.material = AsyncMock(return_value={'materialId': '123', 'status': 'SUCCEEDED',
                                               'materialType': 'VIDEO', 'duration': 16, 'faces': [{'id': '5'}]})
        self.create = AsyncMock(return_value={'taskId': self.task_id, 'taskStatus': 'PENDING'})
        original_cancel = ops._cancel_before_submission
        def cancel(_transaction, *args):
            with self.lock:
                state = deepcopy(self.state)
                result = original_cancel(fixtures.Transaction(state), *args)
                self.state = state
                return result
        for p in (patch.object(flow, 'db', ops.db),
                  patch.object(ops, '_cancel_before_submission', side_effect=cancel),
                  patch.object(flow, 'authorize_target', return_value=('object@immutable-version', self.blob, '1'))):
            p.start()
            self.addCleanup(p.stop)

    async def submit(self, key='operation-1', face='5'):
        return await flow.submit_face_swap('alice', key, '123', face, 'client-url', self.material, self.create)

    async def test_creation_reserves_trusted_video_cost_and_links(self):
        task = await self.submit()
        self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 2.0})
        record = self.state[('generations', task['generationId'])]
        self.assertEqual(record['status'], 'PROCESSING')
        self.assertEqual(record['taskId'], self.task_id)
        self.create.assert_awaited_once_with('123', '5', 'https://storage.invalid/signed')

    async def test_replay_does_not_reserve_or_send_and_rejects_changed_intent(self):
        first = await self.submit()
        before = deepcopy(self.state)
        self.material.side_effect = AssertionError('replay must not query material')
        self.assertEqual(await self.submit(), first)
        self.assertEqual(self.state, before)
        self.create.assert_awaited_once()
        with self.assertRaises(HTTPException) as error:
            await self.submit(face='6')
        self.assertEqual(error.exception.status_code, 409)

    async def test_concurrent_requests_send_at_most_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            def submit(_):
                try:
                    return asyncio.run(self.submit())
                except HTTPException as error:
                    self.assertEqual(error.status_code, 409)
            list(pool.map(submit, range(2)))
        self.create.assert_awaited_once()
        self.assertEqual(self.state[('users', 'alice')]['reservedCredits'], 2)

    async def test_timeout_and_invalid_response_preserve_and_never_resend(self):
        for response in ('timeout', 'invalid'):
            self.state = {('users', 'alice'): {'credits': 5.0, 'reservedCredits': 0.0}}
            self.create.reset_mock()
            self.create.side_effect = httpx.ReadTimeout('secret') if response == 'timeout' else None
            self.create.return_value = {}
            with self.assertRaises(HTTPException) as error:
                await self.submit()
            self.assertEqual(error.exception.status_code, 502)
            self.assertNotIn('secret', str(error.exception.detail))
            with self.assertRaises(HTTPException) as error:
                await self.submit()
            self.assertEqual(error.exception.status_code, 409)
            self.create.assert_awaited_once()
            self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 2.0})

    async def test_link_storage_failure_preserves_reserve_and_blocks_resend(self):
        with patch.object(ops, 'link_face_swap_task', side_effect=RuntimeError('secret')):
            with self.assertRaises(HTTPException) as error:
                await self.submit()
        self.assertEqual(error.exception.status_code, 503)
        with self.assertRaises(HTTPException):
            await self.submit()
        self.create.assert_awaited_once()
        self.assertEqual(self.state[('users', 'alice')]['reservedCredits'], 2)

    async def test_signing_failure_cancels_before_send(self):
        self.blob.generate_signed_url.side_effect = RuntimeError('secret')
        with self.assertRaises(HTTPException) as error:
            await self.submit()
        self.assertEqual(error.exception.status_code, 503)
        self.create.assert_not_awaited()
        self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 0.0})

    async def test_success_and_failure_finalize_once_preserve_image_reserve(self):
        image = fixtures.credits.reserve_generation_credits('alice', 'image', 0.2, 'image-generation', 'text-to-image')
        image_key = ('generations', image['generationId'])
        original = deepcopy(self.state[image_key])
        await self.submit()
        await flow.finalize_linked_task('alice', self.task_id)
        await flow.finalize_linked_task('alice', self.task_id)
        self.assertEqual(self.state[image_key], original)
        self.assertEqual(self.state[('users', 'alice')]['credits'], 3)
        self.assertAlmostEqual(self.state[('users', 'alice')]['reservedCredits'], 0.2)

    async def test_failed_provider_task_releases_once(self):
        await self.submit()
        self.fetch.return_value['taskStatus'] = 'FAILED'
        for _ in range(2):
            await flow.finalize_linked_task('alice', self.task_id)
        self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 0.0})

    async def test_legacy_debited_task_never_finalized(self):
        self.state[self.task_key] = {'uid': 'alice', 'taskId': self.task_id}
        self.assertIsNone(await flow.finalize_linked_task('alice', self.task_id))
        self.fetch.assert_not_awaited()

    async def test_transaction_contention_is_controlled_without_external_send(self):
        with patch.object(ops, 'reserve_face_swap_operation', side_effect=RuntimeError('private lock detail')):
            with self.assertRaises(HTTPException) as error:
                await self.submit()
        self.assertEqual(error.exception.status_code, 503)
        self.assertNotIn('private', str(error.exception.detail))
        self.create.assert_not_awaited()
        self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 0.0})

    async def test_changed_target_generation_conflicts_with_same_key(self):
        await self.submit()
        with patch.object(flow, 'authorize_target', return_value=('object@different-version', self.blob, '2')):
            with self.assertRaises(HTTPException) as error:
                await self.submit()
        self.assertEqual(error.exception.status_code, 409)
        self.create.assert_awaited_once()

    async def test_invalid_material_or_face_never_reserves(self):
        original = deepcopy(self.material.return_value)
        for change, status in (({'status': 'PENDING'}, 409), ({'faces': []}, 400),
                               ({'faces': None}, 502), ({'materialType': 'GIF'}, 400)):
            self.material.return_value = {**original, **change}
            with self.assertRaises(HTTPException) as error:
                await self.submit()
            self.assertEqual(error.exception.status_code, status)
            self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 0.0})
        self.create.assert_not_awaited()


class TargetAuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.bucket = Mock(name='bucket')
        self.bucket.name = 'demo-bucket'
        self.blob = self.bucket.blob.return_value
        self.blob.generation = 123
        self.blob.size = 100
        self.blob.content_type = 'image/png'
        self.firebase = Mock(bucket=self.bucket)
        self.url = 'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/face-swap-faces%2Falice%2F12345678-1234-4123-8123-123456789abc.png?token=untrusted'

    def authorize(self, uid='alice', url=None):
        with patch.dict(fixtures.helpers.sys.modules, {'app.services.firebase': self.firebase}):
            return flow.authorize_target(uid, url or self.url)

    def test_backend_resolves_owned_object_and_generation_ignoring_token(self):
        identity, blob, version = self.authorize()
        self.assertEqual(identity, 'demo-bucket/face-swap-faces/alice/12345678-1234-4123-8123-123456789abc.png@123')
        self.assertEqual(version, '123')
        self.assertIs(blob, self.blob)
        self.blob.reload.assert_called_once()

    def test_token_free_target_reference(self):
        identity, blob, version = self.authorize(url=self.url.split("?")[0])
        self.assertEqual(version, "123")
        self.assertIs(blob, self.blob)
        self.assertEqual(identity, self.authorize()[0])

    def test_other_owner_bucket_and_external_urls_rejected(self):
        for url in (self.url.replace('alice', 'bob'), self.url.replace('demo-bucket', 'other'),
                    'https://example.com/face.png', self.url.replace('https:', 'http:')):
            with self.assertRaises(HTTPException) as error:
                self.authorize(url=url)
            self.assertEqual(error.exception.status_code, 403)
        self.blob.reload.assert_not_called()
