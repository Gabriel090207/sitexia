"""Offline reconciliation with real finalizers and serializable mock commits."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
from unittest.mock import Mock, patch

import httpx
import test_face_swap_finalization as financial

operations = financial.operations
fixtures = financial.fixtures
with patch.dict(fixtures.helpers.sys.modules, {
    'app.services.firebase': fixtures.helpers.firebase,
    'app.services.face_swap_operations': operations,
    'app.services.generation_credits': fixtures.credits,
}):
    reconciliation = fixtures.helpers.load('tested_swap_reconciliation', 'app/services/face_swap_reconciliation.py')


class ReconciliationTests(unittest.IsolatedAsyncioTestCase):
    reserve = financial.FinalizationTests.reserve
    acquire = financial.FinalizationTests.acquire
    link = financial.FinalizationTests.link

    def setUp(self):
        financial.FinalizationTests.setUp(self)
        db = operations.db
        # A small query implementation exercises real pagination/filter code.
        case = self
        class Query:
            def __init__(self, name, filters=(), cursor=None, size=None):
                self.name, self.filters, self.cursor, self.size = name, filters, cursor, size
            def document(self, identifier):
                return db.collection_original(self.name).document(identifier)
            def where(self, *, filter):
                return Query(self.name, (*self.filters, (filter.field_path, filter.value)), self.cursor, self.size)
            def order_by(self, field):
                assert field == '__name__'
                return self
            def start_after(self, cursor):
                return Query(self.name, self.filters, cursor['__name__'].key[1], self.size)
            def limit(self, size):
                assert 1 <= size <= 1000
                return Query(self.name, self.filters, self.cursor, size)
            def stream(self):
                assert self.size is not None
                keys = sorted(identifier for (name, identifier), data in case.state.items()
                              if name == self.name and (self.cursor is None or identifier > self.cursor)
                              and all(data.get(k) == v for k, v in self.filters))[:self.size]
                return [Mock(id=key, reference=self.document(key)) for key in keys]
        db.collection_original = db.collection.side_effect
        self.query_db = Mock()
        self.query_db.collection.side_effect = lambda name: Query(name)
        p = patch.object(reconciliation, 'db', self.query_db)
        p.start()
        self.addCleanup(p.stop)

    async def run_page(self, **kwargs):
        return await reconciliation.reconcile_face_swap_reservations(**kwargs)

    async def test_success_charges_and_repeat_skips(self):
        self.state[self.key]['reservationIntent']['duration'] = 999
        result = await self.run_page()
        self.assertEqual(result['results'][0]['outcome'], 'charged')
        self.assertEqual(self.state[('users', 'alice')], {'credits': 3.0, 'reservedCredits': 0.0})
        before = deepcopy(self.state)
        self.assertEqual((await self.run_page())['results'], [])
        self.assertEqual(self.state, before)
        self.fetch.assert_awaited_once()

    async def test_failure_releases_without_charge(self):
        self.fetch.return_value['taskStatus'] = 'FAILED'
        self.assertEqual((await self.run_page())['results'][0]['outcome'], 'released')
        self.assertEqual(self.state[('users', 'alice')], {'credits': 5.0, 'reservedCredits': 0.0})

    async def test_pending_running_unknown_preserve_reserve(self):
        before = deepcopy(self.state)
        for status in ('PENDING', 'RUNNING', 'UNKNOWN'):
            self.fetch.return_value['taskStatus'] = status
            self.assertEqual((await self.run_page())['results'][0]['outcome'], 'kept_processing_or_unknown')
            self.assertEqual(self.state, before)

    async def test_errors_and_inconclusive_responses_preserve_reserve(self):
        before = deepcopy(self.state)
        for error in (httpx.ReadTimeout('SECRET_URL'),
                      httpx.HTTPStatusError('SECRET_URL', request=httpx.Request('GET', 'https://example.invalid'),
                                            response=httpx.Response(404)), RuntimeError('SECRET_URL')):
            self.fetch.side_effect = error
            with self.assertLogs(reconciliation.logger, level='WARNING') as logs:
                self.assertEqual((await self.run_page())['results'][0]['outcome'], 'kept_error')
            self.assertNotIn('SECRET_URL', str(logs.output))
            self.assertEqual(self.state, before)
        self.fetch.side_effect = None
        for data in (None, {}, {'taskStatus': 'unexpected'}, {'taskId': '999', 'taskStatus': 'SUCCEEDED'}):
            self.fetch.return_value = data
            await self.run_page()
            self.assertEqual(self.state, before)

    async def test_terminal_operations_not_selected(self):
        for state in ('charged', 'released'):
            self.state[self.key]['creditStatus'] = state
            before = deepcopy(self.state)
            self.assertEqual((await self.run_page())['results'], [])
            self.assertEqual(self.state, before)
        self.fetch.assert_not_awaited()

    async def test_submitting_without_task_is_review_only(self):
        self.state[self.key].update(status='SUBMITTING', taskId=None)
        before = deepcopy(self.state)
        self.assertEqual((await self.run_page())['results'][0]['outcome'], 'review_submitting_without_task')
        self.assertEqual(self.state, before)
        self.fetch.assert_not_awaited()

    async def test_legacy_task_and_missing_financial_link_never_consulted(self):
        self.state[self.task_key].pop('generationId')
        before = deepcopy(self.state)
        self.assertEqual((await self.run_page())['results'][0]['outcome'], 'review_invalid_link_or_evidence')
        self.fetch.assert_not_awaited()
        self.assertEqual(self.state, before)
        del self.state[self.key]
        self.assertEqual((await self.run_page())['results'], [])

    async def test_pagination_progresses_past_unlinked_operations(self):
        for number in range(1, 5):
            key = f'{number:064x}'
            self.state[('generations', key)] = {'type': 'face-swap', 'creditStatus': 'reserved', 'status': 'SUBMITTING', 'taskId': None}
        cursor, seen = None, []
        while True:
            page = await self.run_page(limit=2, after_id=cursor)
            seen.extend(item['generationId'] for item in page['results'])
            cursor = page['next_cursor']
            if cursor is None:
                break
            self.assertLess(len(seen), 10)
        self.assertEqual(len(seen), 5)
        self.assertEqual(len(set(seen)), 5)

    async def test_individual_failure_does_not_block_other_operation(self):
        broken_id = '0' * 64
        self.state[('generations', broken_id)] = {**self.state[self.key], 'generationId': broken_id}
        result = await self.run_page()
        self.assertEqual([item['outcome'] for item in result['results']], ['review_invalid_link_or_evidence', 'charged'])

    async def test_images_and_their_reserves_untouched(self):
        image = fixtures.credits.reserve_generation_credits('alice', 'image-key', 0.2, 'image-generation', 'text-to-image')
        image_key = ('generations', image['generationId'])
        original = deepcopy(self.state[image_key])
        await self.run_page()
        self.assertEqual(self.state[image_key], original)
        self.assertAlmostEqual(self.state[('users', 'alice')]['reservedCredits'], 0.2)
        self.assertEqual(self.state[('users', 'alice')]['credits'], 3.0)

    async def test_concurrent_reconciliation_moves_funds_once(self):
        for status, balance in (('SUCCEEDED', 3.0), ('FAILED', 5.0)):
            self.state[self.key].update(creditStatus='reserved', status='PROCESSING')
            self.state[('users', 'alice')] = {'credits': 5.0, 'reservedCredits': 2.0}
            self.fetch.return_value['taskStatus'] = status
            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda _: asyncio.run(self.run_page()), range(8)))
            self.assertEqual(self.state[('users', 'alice')], {'credits': balance, 'reservedCredits': 0.0})

    async def test_stale_page_skips_already_finalized(self):
        stale = reconciliation.list_reserved_face_swap_operations()
        await self.run_page()
        before = deepcopy(self.state)
        with patch.object(reconciliation, 'list_reserved_face_swap_operations', return_value=stale):
            self.assertEqual((await self.run_page())['results'][0]['outcome'], 'skipped')
        self.assertEqual(self.state, before)

    async def test_invalid_limits_and_cursors(self):
        for limit in (True, 0, -1, 1001, 1.5):
            with self.assertRaises(ValueError):
                await self.run_page(limit=limit)
        for cursor in ('', 'a/b', 123):
            with self.assertRaises(ValueError):
                await self.run_page(after_id=cursor)
        self.fetch.assert_not_awaited()


if __name__ == '__main__':
    unittest.main()
