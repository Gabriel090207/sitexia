"""Atomic link tests with a serializable in-memory transaction mock."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
from unittest.mock import Mock, patch

import test_face_swap_submission as submission
import test_face_swap_tasks as task_tests

fixtures = submission.fixtures
operations = submission.operations


class LinkTests(unittest.TestCase):
    def setUp(self):
        submission.SubmissionTests.setUp(self)
        self.grant = self.acquire()
        self.attempt = self.grant["submissionAttemptId"]
        self.task_id = "9876543210987654321"
        self.task_key = ("face_swap_tasks", self.task_id)
        self.db = Mock()
        self.db.collection.side_effect = lambda name: Mock(document=lambda identifier: fixtures.Reference(name, identifier))
        original = operations._link_task

        def atomic_link(_transaction, *args):
            with self.lock:
                state = deepcopy(self.state)
                result = original(fixtures.Transaction(state), *args)
                if self.fail_commit:
                    raise RuntimeError("simulated transaction failure")
                self.state = state
                return result

        for p in (patch.object(operations, "db", self.db),
                  patch.object(operations, "_link_task", side_effect=atomic_link)):
            p.start()
            self.addCleanup(p.stop)

    reserve = fixtures.OperationTests.reserve
    acquire = submission.SubmissionTests.acquire

    def link(self, **overrides):
        args = dict(uid="alice", generation_id=self.identifier, attempt_id=self.attempt, task_id=self.task_id)
        args.update(overrides)
        return operations.link_face_swap_task(**args)

    def test_valid_link_is_atomic_and_preserves_finances_and_intent(self):
        users = {k: deepcopy(v) for k, v in self.state.items() if k[0] == "users"}
        result = self.link(task_id="000" + self.task_id)
        self.assertEqual(result["taskId"], self.task_id)
        self.assertEqual(result["status"], "PROCESSING")
        self.assertEqual(result["creditStatus"], "reserved")
        self.assertEqual(result["reservationIntent"], self.grant["reservationIntent"])
        self.assertEqual(result["submissionAttemptId"], self.attempt)
        self.assertIn("taskLinkedAt", result)
        self.assertEqual(users, {k: v for k, v in self.state.items() if k[0] == "users"})
        owner = self.state[self.task_key]
        self.assertEqual(owner["uid"], "alice")
        self.assertEqual(owner["taskId"], self.task_id)
        self.assertEqual(owner["generationId"], self.identifier)
        self.assertEqual(owner["materialId"], "123")
        self.assertEqual(owner["sourceFaceId"], "5")
        self.assertEqual(owner["submissionAttemptId"], self.attempt)
        self.assertIn("createdAt", owner)

    def test_missing_or_other_owner(self):
        for overrides in ({"generation_id": "0" * 64}, {"uid": "bob"}):
            with self.assertRaises(operations.FaceSwapOperationNotFound):
                self.link(**overrides)
        self.assertNotIn(self.task_key, self.state)

    def test_wrong_attempt(self):
        for attempt in ("0" * 32, "invalid", "", None):
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.link(attempt_id=attempt)
        self.assertNotIn(self.task_key, self.state)

    def test_invalid_operational_states(self):
        for status in ("CREATED", "PENDING", "UNKNOWN", "SUCCEEDED", "FAILED", "SUBMISSION_UNKNOWN"):
            self.state[self.key]["status"] = status
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.link()
        self.assertNotIn(self.task_key, self.state)

    def test_invalid_financial_reserve(self):
        for credit_status in ("charged", "released", None):
            self.state[self.key]["creditStatus"] = credit_status
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.link()
        self.state[self.key]["creditStatus"] = "reserved"
        self.state[("users", "alice")]["reservedCredits"] = 0
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.link()

    def test_invalid_task_ids(self):
        for task_id in (None, True, 1.5, "-1", "0", "abc", "１２３"):
            with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
                self.link(task_id=task_id)
        self.assertNotIn(self.task_key, self.state)

    def test_identical_retry_has_no_writes_or_new_timestamps(self):
        first = self.link()
        before = deepcopy(self.state)
        self.assertEqual(self.link(), first)
        self.assertEqual(self.state, before)

    def test_operation_cannot_receive_second_task(self):
        self.link()
        before = deepcopy(self.state)
        with self.assertRaises(operations.ReservationConflict):
            self.link(task_id="123456789")
        self.assertEqual(self.state, before)

    def test_existing_tasks_never_claimed_even_same_owner_legacy(self):
        for owner in (
            {"uid": "bob", "taskId": self.task_id},
            {"uid": "alice", "taskId": self.task_id},
            {"uid": "alice", "taskId": self.task_id, "generationId": "different"},
        ):
            self.state[self.task_key] = owner
            before = deepcopy(self.state)
            with self.assertRaises(operations.ReservationConflict):
                self.link()
            self.assertEqual(self.state, before)

    def test_task_cannot_belong_to_two_operations(self):
        self.link()
        second = self.reserve(operation_id="other")
        grant = self.acquire(identifier=second["generationId"])
        with self.assertRaises(operations.ReservationConflict):
            self.link(generation_id=second["generationId"], attempt_id=grant["submissionAttemptId"])
        self.assertEqual(self.state[self.task_key]["generationId"], self.identifier)

    def test_failed_transaction_leaves_neither_partial_link_nor_resend_permission(self):
        before = deepcopy(self.state)
        self.fail_commit = True
        with self.assertRaises(RuntimeError):
            self.link()
        self.assertEqual(self.state, before)
        self.fail_commit = False
        with self.assertRaises(operations.FaceSwapSubmissionUnavailable):
            self.acquire()
        self.link()  # Recover the known task binding, without another provider request.

    def test_existing_authorization_accepts_new_schema(self):
        self.link()
        snapshot = Mock(exists=True, to_dict=lambda: deepcopy(self.state[self.task_key]))
        db = Mock()
        db.collection.return_value.document.return_value.get.return_value = snapshot
        check = task_tests.routes.require_task_owner
        with patch.dict(check.__globals__, {"db": db}):
            check(self.task_id, "alice")
            with self.assertRaises(task_tests.routes.HTTPException) as caught:
                check(self.task_id, "bob")
        self.assertEqual(caught.exception.status_code, 404)

    def test_simulated_concurrent_conflicting_tasks_have_one_winner(self):
        def link(task_id):
            try:
                return self.link(task_id=task_id)["taskId"]
            except operations.ReservationConflict:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(link, (self.task_id, "123456789")))
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(sum(key[0] == "face_swap_tasks" for key in self.state), 1)


if __name__ == "__main__":
    unittest.main()
