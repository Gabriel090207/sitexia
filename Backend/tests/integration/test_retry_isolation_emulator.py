"""Repeated real transactions; classify lock exhaustion separately from safety.

Existing strict contention tests remain unchanged. All data/transport comes from
our loopback-only demo fixture. No provider functions are called.
"""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch

from google.api_core.exceptions import Aborted
from google.cloud.firestore_v1.transaction import Transaction
import test_face_swap_emulator as base


def lock_timeout(error):
    cause = error.__cause__ if isinstance(error, ValueError) else error
    return isinstance(cause, Aborted) and "Transaction lock timeout" in str(cause)


class RepeatedIsolationTests(unittest.TestCase):
    def test_21_concurrent_rounds_preserve_retry_ownership_and_finances(self):
        scenarios = ('same-key', 'different-keys', 'acquire', 'charge', 'release', 'cancel-acquire', 'image-reserve')
        failures = foreign_ids = 0
        rounds_with_timeouts = 0
        for scenario in scenarios:
            for number in range(1, 4):
                case = base.EmulatorFinanceTests('test_reserve_sufficient_balance')
                case.setUp()
                history, foreign = {}, []
                original_begin = Transaction._begin

                def begin(tx, retry_id=None):
                    foreign.append(retry_id is not None and retry_id not in history.get(id(tx), []))
                    value = original_begin(tx, retry_id=retry_id)
                    history.setdefault(id(tx), []).append(tx._id)
                    return value

                def reserve():
                    return case.reserve()

                def finish(record, task_id, status):
                    return base.ops._finalize_confirmed_task(base.client.transaction(), case.uid,
                        record['generationId'], task_id, status)

                try:
                    image_ref = image_before = None
                    if scenario in ('charge', 'release', 'image-reserve'):
                        if scenario == 'image-reserve':
                            image = base.credits.reserve_generation_credits(case.uid, 'image', 0.2, 'image-generation', 'text-to-image')
                            image_ref = base.client.collection('generations').document(image['generationId'])
                            image_before = image_ref.get().to_dict()
                        record, _, task_id = case.linked()
                        status = 'FAILED' if scenario == 'release' else 'SUCCEEDED'
                        action = lambda _: finish(record, task_id, status)
                    elif scenario in ('acquire', 'cancel-acquire'):
                        record = reserve()
                        def action(index):
                            function = (base.ops.cancel_face_swap_operation if scenario == 'cancel-acquire' and index == 0
                                        else base.ops.acquire_face_swap_submission)
                            return function(case.uid, record['generationId'])
                    elif scenario == 'different-keys':
                        action = lambda index: case.reserve('key-' + str(index))
                    else:
                        action = lambda _: reserve()

                    def attempt(index):
                        try:
                            action(index)
                            return 'ok'
                        except base.ops.FaceSwapSubmissionUnavailable:
                            return 'denied'
                        except Exception as error:
                            if lock_timeout(error):
                                return 'emulator_lock_timeout'
                            raise

                    with patch.object(Transaction, '_begin', begin):
                        results = case.parallel(attempt)
                    self.assertFalse(any(foreign), 'A: retry ID crossed invocations')
                    count = results.count('emulator_lock_timeout')
                    failures += count
                    rounds_with_timeouts += count > 0
                    foreign_ids += sum(foreign)
                    user = case.user.get().to_dict()
                    docs = list(base.client.collection('generations').where(
                        filter=base.FieldFilter('userId', '==', case.uid)).stream())
                    face_docs = [doc for doc in docs if doc.to_dict()['type'] == 'face-swap']
                    self.assertGreaterEqual(user['reservedCredits'], 0)
                    self.assertLessEqual(user['reservedCredits'], user['credits'])

                    if scenario in ('same-key', 'different-keys'):
                        self.assertEqual(user['credits'], 5)
                        self.assertEqual(user['reservedCredits'], 2 * len(face_docs))
                        self.assertLessEqual(len(face_docs), 1 if scenario == 'same-key' else 2)
                        keys = ('operation',) if scenario == 'same-key' else ('key-0', 'key-1')
                        for key in keys:
                            first = case.reserve(key)
                            self.assertEqual(case.reserve(key)['generationId'], first['generationId'])
                        case.balances(5, 2 * len(keys))
                    elif scenario in ('acquire', 'cancel-acquire'):
                        self.assertLessEqual(results.count('ok'), 1, 'Two exclusive transitions succeeded')
                        stored = base.client.collection('generations').document(record['generationId']).get().to_dict()
                        if scenario == 'cancel-acquire' and results[0] == 'ok':
                            self.assertEqual(stored['status'], 'FAILED')
                        if scenario == 'cancel-acquire' and results[1] == 'ok':
                            self.assertEqual(stored['status'], 'SUBMITTING')
                        if stored['status'] == 'CREATED':
                            # Neither commit won: a sequential replay may still
                            # acquire once, with the same durable reservation.
                            base.ops.acquire_face_swap_submission(case.uid, record['generationId'])
                            stored = base.client.collection('generations').document(record['generationId']).get().to_dict()
                        self.assertIn(stored['status'], ('SUBMITTING', 'FAILED'))
                        with self.assertRaises(base.ops.FaceSwapSubmissionUnavailable):
                            base.ops.acquire_face_swap_submission(case.uid, record['generationId'])
                        case.balances(5, 2 if stored['status'] == 'SUBMITTING' else 0)
                    else:
                        # Check persisted state BEFORE any recovery, then repeat
                        # the same known-task finalization; never create a task.
                        stored = base.client.collection('generations').document(record['generationId']).get().to_dict()
                        charged = stored['creditStatus'] == 'charged'
                        held = stored['creditStatus'] == 'reserved'
                        self.assertEqual(user['credits'], 3 if charged else 5)
                        expected_reserve = (2 if held else 0) + (0.2 if image_ref else 0)
                        self.assertAlmostEqual(user['reservedCredits'], expected_reserve)
                        finish(record, task_id, status)
                        stable = deepcopy(case.user.get().to_dict())
                        finish(record, task_id, status)
                        self.assertEqual(case.user.get().to_dict(), stable)
                        self.assertEqual(stable['credits'], 5 if scenario == 'release' else 3)
                        self.assertAlmostEqual(stable['reservedCredits'], 0.2 if image_ref else 0)
                        if image_ref:
                            self.assertEqual(image_ref.get().to_dict(), image_before)
                    print('ISOLATION_ROUND', json.dumps({'scenario': scenario, 'round': number, 'results': results,
                        'foreignRetryIds': sum(foreign), 'integrity': 'passed'}), flush=True)
                finally:
                    case.tearDown()
        print('ISOLATION_TOTAL', json.dumps({'rounds': 21, 'concurrentCalls': 42,
            'roundsWithEmulatorTimeouts': rounds_with_timeouts, 'emulatorTimeouts': failures,
            'foreignRetryIds': foreign_ids, 'integrityFailures': 0}), flush=True)

    def test_image_generation_financial_contract_unchanged(self):
        case = base.EmulatorFinanceTests('test_reserve_sufficient_balance')
        case.setUp()
        try:
            reserve = base.credits.reserve_generation_credits
            first = reserve(case.uid, 'image-success', 0.2, 'image-generation', 'text-to-image')
            self.assertNotIn('reservationIntent', first)
            self.assertEqual(reserve(case.uid, 'image-success', 0.2, 'image-generation', 'text-to-image')['generationId'], first['generationId'])
            case.balances(5, 0.2)
            base.credits.attach_generation_task(first['generationId'], case.task_id())
            base.credits.charge_reserved_generation(first['generationId'])
            base.credits.charge_reserved_generation(first['generationId'])
            self.assertEqual(base.credits.release_reserved_generation(first['generationId'])['creditStatus'], 'charged')
            case.balances(4.8, 0)
            second = reserve(case.uid, 'image-failure', 0.2, 'image-generation', 'text-to-image')
            base.credits.attach_generation_task(second['generationId'], case.task_id())
            base.credits.release_reserved_generation(second['generationId'])
            base.credits.release_reserved_generation(second['generationId'])
            self.assertEqual(base.credits.charge_reserved_generation(second['generationId'])['creditStatus'], 'released')
            case.balances(4.8, 0)
        finally:
            case.tearDown()


if __name__ == '__main__':
    unittest.main()
