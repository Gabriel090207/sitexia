"""Offline cancellations using real balance primitives and serializable mock commits.

No Firebase client, credentials, provider requests or production writes.
Threaded cases simulate serialization; they do not emulate Firestore contention.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import threading
import unittest
from unittest.mock import patch

import test_face_swap_submission as submissions

fixtures = submissions.fixtures
operations = fixtures.operations


class CancellationTests(unittest.TestCase):
    def setUp(self):
        submissions.SubmissionTests.setUp(self)
        db = operations.db
        original = operations._cancel_before_submission

        def cancel(_transaction, *args):
            with self.lock:
                state = deepcopy(self.state)
                result = original(fixtures.Transaction(state), *args)
                if self.fail_commit:
                    raise RuntimeError("simulated commit failure")
                self.state = state
                return result

        for p in (patch.object(fixtures.credits, "db", db),
                  patch.object(operations, "_cancel_before_submission", side_effect=cancel)):
            p.start()
            self.addCleanup(p.stop)

    reserve = fixtures.OperationTests.reserve
    acquire = submissions.SubmissionTests.acquire

    def cancel(self, uid="alice", identifier=None):
        return operations.cancel_face_swap_operation(uid, identifier or self.identifier)

    def test_valid_cancel_preserves_frozen_record_and_other_reserves(self):
        self.reserve(operation_id="other")
        result = self.cancel()
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(result["creditStatus"], "released")
        self.assertEqual(result["cancellationReason"], "before_submission")
        self.assertIn("cancelledAt", result)
        for field in ("generationId", "userId", "type", "mode", "cost", "reservationIntent", "taskId", "createdAt"):
            self.assertEqual(result[field], self.record[field])
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 2.0})

    def test_repeated_cancel_is_noop_even_after_lost_commit_reply(self):
        first = self.cancel()
        before = deepcopy(self.state)
        self.assertEqual(self.cancel(), first)
        self.assertEqual(self.state, before)

    def test_cancelled_operation_cannot_reserve_send_link_or_charge_again(self):
        self.cancel()
        before = deepcopy(self.state)
        self.assertEqual(self.reserve()["creditStatus"], "released")
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            operations._link_task(fixtures.Transaction(self.state), "alice", self.identifier, "a" * 32, "999")
        with self.assertRaises(operations.InvalidFaceSwapEvidence):
            operations._validate_finalization(self.state[self.key], "alice", self.identifier)
        # Even the shared trusted-backend primitive cannot reverse a release.
        result = fixtures.credits.finalize_generation_in_transaction(
            fixtures.Transaction(self.state), self.identifier, True,
        )
        self.assertEqual(result["creditStatus"], "released")
        self.assertEqual(self.state, before)

    def test_acquired_and_inconclusive_operations_keep_reservation(self):
        self.acquire()
        acquired = deepcopy(self.state[self.key])
        for status in ("SUBMITTING", "SUBMISSION_UNKNOWN", "PENDING", "RUNNING", "UNKNOWN", "FAILED"):
            self.state[self.key] = {**acquired, "status": status}
            before = deepcopy(self.state)
            with self.subTest(status=status), self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.cancel()
            self.assertEqual(self.state, before)

    def test_linked_charged_and_other_releases_cannot_be_cancelled(self):
        for change in (
            {"taskId": "999", "status": "PROCESSING", "taskLinkedAt": "timestamp"},
            {"status": "SUCCEEDED", "creditStatus": "charged"},
            {"status": "FAILED", "creditStatus": "released"},
            {"submissionAttemptId": None}, {"submissionAcquiredAt": None}, {"taskLinkedAt": None},
        ):
            self.state[self.key] = {**self.record, **change}
            before = deepcopy(self.state)
            with self.subTest(change=change), self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.cancel()
            self.assertEqual(self.state, before)

    def test_invalid_owner_identifiers_and_intent_fail_closed(self):
        before = deepcopy(self.state)
        for uid, identifier in (("bob", self.identifier), ("alice", "0" * 64), ("", self.identifier), ("alice", "invalid")):
            with self.assertRaises(operations.FaceSwapOperationNotFound):
                operations.cancel_face_swap_operation(uid, identifier)
        self.assertEqual(self.state, before)
        for change in ({"type": "image-generation"}, {"cost": 1}, {"reservationIntent": {}}):
            self.state[self.key] = {**self.record, **change}
            before = deepcopy(self.state)
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.cancel()
            self.assertEqual(self.state, before)

    def test_commit_failure_rolls_back_release_and_audit(self):
        before = deepcopy(self.state)
        self.fail_commit = True
        with self.assertRaises(RuntimeError):
            self.cancel()
        self.assertEqual(self.state, before)
        self.fail_commit = False
        self.cancel()
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 0.0})

    def test_invalid_balance_keeps_reservation(self):
        self.state[("users", "alice")]["reservedCredits"] = 1
        before = deepcopy(self.state)
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.cancel()
        self.assertEqual(self.state, before)

    def test_concurrent_cancellations_release_once(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.cancel(), range(12)))
        self.assertTrue(all(result["creditStatus"] == "released" for result in results))
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 0.0})

    def test_cancel_and_acquire_race_have_one_winner(self):
        barrier = threading.Barrier(2)

        def attempt(action):
            barrier.wait(timeout=5)
            try:
                action()
                return True
            except operations.FaceSwapSubmissionUnavailable:
                return False

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(attempt, (self.cancel, self.acquire)))
        self.assertEqual(sum(results), 1)
        released = self.state[self.key]["creditStatus"] == "released"
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 0.0 if released else 2.0})
        self.assertEqual(self.state[self.key]["status"], "FAILED" if released else "SUBMITTING")

    def test_acquisition_wins_then_cancel_is_denied(self):
        self.acquire()
        before = deepcopy(self.state)
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.cancel()
        self.assertEqual(self.state, before)


if __name__ == "__main__":
    unittest.main()
