"""Serializable mock acquisition tests; actual Firestore contention needs Emulator."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
from unittest.mock import Mock, patch

import test_face_swap_operations as fixtures

operations = fixtures.operations


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        fixtures.OperationTests.setUp(self)
        self.record = self.reserve()
        self.identifier = self.record["generationId"]
        self.key = ("generations", self.identifier)
        db = Mock()
        db.collection.side_effect = lambda name: Mock(document=lambda identifier: fixtures.Reference(name, identifier))
        original = operations._acquire_submission

        def acquire(_transaction, *args):
            with self.lock:
                state = deepcopy(self.state)
                result = original(fixtures.Transaction(state), *args)
                if self.fail_commit:
                    raise RuntimeError("simulated transaction failure")
                self.state = state
                return result

        for p in (patch.object(operations, "db", db),
                  patch.object(operations, "_acquire_submission", side_effect=acquire)):
            p.start()
            self.addCleanup(p.stop)

    reserve = fixtures.OperationTests.reserve

    def acquire(self, uid="alice", identifier=None):
        return operations.acquire_face_swap_submission(uid, identifier or self.identifier)

    def test_valid_acquisition_preserves_identity_and_balances(self):
        users = {k: deepcopy(v) for k, v in self.state.items() if k[0] == "users"}
        result = self.acquire()
        self.assertEqual(result["status"], "SUBMITTING")
        self.assertEqual(len(result["submissionAttemptId"]), 32)
        self.assertIn("submissionAcquiredAt", result)
        self.assertEqual(result["creditStatus"], "reserved")
        self.assertEqual(result["reservationIntent"], self.record["reservationIntent"])
        self.assertEqual(result["cost"], self.record["cost"])
        self.assertEqual(result["createdAt"], self.record["createdAt"])
        self.assertEqual(users, {k: v for k, v in self.state.items() if k[0] == "users"})
        self.assertIsNone(result["taskId"])

    def test_missing_and_other_owner_are_indistinguishable(self):
        for uid, identifier in (("alice", "0" * 64), ("bob", self.identifier)):
            with self.assertRaises(operations.FaceSwapOperationNotFound) as caught:
                self.acquire(uid, identifier)
            self.assertEqual(str(caught.exception), "Operação não encontrada.")

    def test_invalid_reservation_and_corrupt_intent(self):
        for change in ({"creditStatus": "released"}, {"cost": True}, {"cost": 1},
                       {"type": "image-generation"}, {"reservationIntent": {}},
                       {"taskId": "123"}, {"generationId": "different"}):
            self.state[self.key] = {**self.record, **change}
            before = deepcopy(self.state)
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.acquire()
            self.assertEqual(self.state, before)

    def test_invalid_aggregate_reserve_blocks_acquisition(self):
        for balance in ({"credits": 5, "reservedCredits": 1},
                        {"credits": 1, "reservedCredits": 2},
                        {"credits": True, "reservedCredits": 2},
                        {"credits": 5, "reservedCredits": float("inf")}):
            self.state[("users", "alice")] = balance
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.acquire()
        del self.state[("users", "alice")]
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()

    def test_second_acquisition_cannot_get_new_grant(self):
        self.acquire()
        before = deepcopy(self.state)
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()
        self.assertEqual(self.state, before)

    def test_simulated_concurrent_acquisitions_have_one_winner(self):
        def attempt(_):
            try:
                return self.acquire()["submissionAttemptId"]
            except operations.FaceSwapSubmissionUnavailable:
                return None
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(attempt, range(12)))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(self.state[("users", "alice")]["reservedCredits"], 2)

    def test_restart_does_not_reauthorize_persisted_operation(self):
        self.acquire()
        # Load fresh service code; only persisted data survives.
        with patch.dict(fixtures.helpers.sys.modules, {
            "app.services.firebase": fixtures.helpers.firebase,
            "app.services.face_swap_materials": fixtures.helpers.ownership,
            "app.services.generation_credits": fixtures.credits,
        }), patch("firebase_admin.firestore.transactional", side_effect=lambda f: f):
            fresh = fixtures.helpers.load("restarted_swap_operations", "app/services/face_swap_operations.py")
        fresh_db = Mock()
        fresh_db.collection.side_effect = lambda name: Mock(document=lambda identifier: fixtures.Reference(name, identifier))
        with patch.object(fresh, "db", fresh_db):
            with self.assertRaises(fresh.FaceSwapSubmissionUnavailable):
                fresh._acquire_submission(fixtures.Transaction(deepcopy(self.state)), "alice", self.identifier, "new-attempt")

    def test_submitted_terminal_unknown_and_stale_attempt_never_reauthorize(self):
        for status in ("SUBMITTING", "SUBMISSION_UNKNOWN", "PENDING", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"):
            self.state[self.key] = {**self.record, "status": status}
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.acquire()
        self.state[self.key] = {**self.record, "submissionAttemptId": "old-attempt",
                                "submissionAcquiredAt": "2000-01-01"}
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()

    def test_failure_rolls_back_and_never_returns_grant(self):
        before = deepcopy(self.state)
        self.fail_commit = True
        with self.assertRaises(RuntimeError):
            self.acquire()
        self.assertEqual(self.state, before)

    def test_lost_response_after_commit_must_not_reauthorize(self):
        self.acquire()  # Simulate committed grant whose return was lost to caller.
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()
        self.assertEqual(self.state[self.key]["status"], "SUBMITTING")


if __name__ == "__main__":
    unittest.main()
