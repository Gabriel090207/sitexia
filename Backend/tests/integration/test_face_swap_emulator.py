"""Run separately: FIRESTORE_EMULATOR_HOST=127.0.0.1:8787 python -B -m unittest
discover -s Backend/tests/integration -v. Requires an already running emulator.
Never imports app.services.firebase or reads application credentials/.env.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4

if os.environ.get("FIRESTORE_EMULATOR_HOST") != "127.0.0.1:8787":
    raise RuntimeError("Refusing to run without the dedicated loopback Firestore Emulator")

from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from google.cloud.firestore_v1.transaction import Transaction
from google.cloud.firestore_v1.base_query import FieldFilter

PROJECT = "demo-xiaswap-finance-tests"
client = firestore.Client(project=PROJECT, credentials=AnonymousCredentials())
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
firebase_stub = types.ModuleType("app.services.firebase")
firebase_stub.db = client
sys.modules["app.services.firebase"] = firebase_stub
from app.services import face_swap_operations as ops


class EmulatorFinanceTests(unittest.TestCase):
    def setUp(self):
        self.uid = "emulator-" + uuid4().hex
        self.user = client.collection("users").document(self.uid)
        self.user.set({"credits": 5.0, "reservedCredits": 0.0})
        self.task_ids = []

    def tearDown(self):
        # Delete only documents created by this test in the explicit demo project.
        for doc in client.collection("generations").where(filter=FieldFilter("userId", "==", self.uid)).stream():
            doc.reference.delete()
        for task_id in self.task_ids:
            client.collection("face_swap_tasks").document(task_id).delete()
        self.user.delete()

    def reserve(self, key="operation"):
        return ops.reserve_face_swap_operation(
            self.uid, key, "123", "5", "object@immutable-version",
            {"materialId": "123", "materialType": "VIDEO", "duration": 16},
        )

    def task_id(self):
        value = str(uuid4().int)
        self.task_ids.append(value)
        return value

    def linked(self, key="operation"):
        record = self.reserve(key)
        grant = ops.acquire_face_swap_submission(self.uid, record["generationId"])
        task_id = self.task_id()
        result = ops.link_face_swap_task(self.uid, record["generationId"], grant["submissionAttemptId"], task_id)
        return result, grant, task_id

    def balances(self, credits, reserved):
        user = self.user.get().to_dict()
        self.assertEqual(user["credits"], credits)
        self.assertEqual(user["reservedCredits"], reserved)
        self.assertGreaterEqual(user["reservedCredits"], 0)
        self.assertLessEqual(user["reservedCredits"], user["credits"])

    def parallel(self, fn):
        barrier = threading.Barrier(2)
        def run(index):
            barrier.wait(timeout=10)
            return fn(index)
        with ThreadPoolExecutor(max_workers=2) as pool:
            return list(pool.map(run, range(2)))

    def finalize(self, record, status):
        # Each caller creates an independent real transaction; provider is mocked.
        return asyncio.run(ops.finalize_face_swap_operation(self.uid, record["generationId"]))

    def test_reserve_sufficient_balance(self):
        result = self.reserve()
        self.assertEqual(result["creditStatus"], "reserved")
        self.balances(5, 2)

    def test_insufficient_considering_other_reserves(self):
        self.user.update({"reservedCredits": 4})
        with self.assertRaises(ops.InsufficientCredits):
            self.reserve()
        self.balances(5, 4)
        self.assertEqual(list(client.collection("generations").where(filter=FieldFilter("userId", "==", self.uid)).stream()), [])

    def test_competing_reservations_do_not_overspend(self):
        self.user.update({"credits": 3})
        def reserve(index):
            try:
                return self.reserve("op-" + str(index))["generationId"]
            except ops.InsufficientCredits:
                return None
        results = self.parallel(reserve)
        self.assertEqual(sum(value is not None for value in results), 1)
        self.balances(3, 2)

    def test_concurrent_idempotency_key_reserves_once(self):
        results = self.parallel(lambda _: self.reserve())
        self.assertEqual(results[0]["generationId"], results[1]["generationId"])
        self.assertEqual(self.reserve()["generationId"], results[0]["generationId"])
        self.balances(5, 2)

    def test_exclusive_submission_under_contention(self):
        record = self.reserve()
        def acquire(_):
            try:
                return ops.acquire_face_swap_submission(self.uid, record["generationId"])
            except ops.FaceSwapSubmissionUnavailable:
                return None
        results = self.parallel(acquire)
        self.assertEqual(sum(value is not None for value in results), 1)
        self.assertIsNone(acquire(0))
        self.balances(5, 2)

    def test_link_and_retry_preserve_bidirectional_ownership(self):
        record, grant, task_id = self.linked()
        owner = client.collection("face_swap_tasks").document(task_id).get().to_dict()
        self.assertEqual(owner["generationId"], record["generationId"])
        self.assertEqual(owner["uid"], self.uid)
        self.assertEqual(record["taskId"], task_id)
        reference = client.collection("generations").document(record["generationId"])
        persisted = reference.get().to_dict()
        # A first write returns SERVER_TIMESTAMP sentinels; compare committed
        # timestamps on retries, rather than treating resolved timestamps as edits.
        self.assertEqual(ops.link_face_swap_task(self.uid, record["generationId"], grant["submissionAttemptId"], task_id), persisted)
        self.assertEqual(reference.get().to_dict(), persisted)
        self.balances(5, 2)

    def test_link_failure_rolls_back_and_known_binding_can_recover(self):
        record = self.reserve()
        grant = ops.acquire_face_swap_submission(self.uid, record["generationId"])
        task_id = self.task_id()
        def fail_update(*args, **kwargs):
            raise RuntimeError("injected before commit after queued task create")
        with patch.object(Transaction, "update", fail_update):
            with self.assertRaises(RuntimeError):
                ops.link_face_swap_task(self.uid, record["generationId"], grant["submissionAttemptId"], task_id)
        self.assertFalse(client.collection("face_swap_tasks").document(task_id).get().exists)
        stored = client.collection("generations").document(record["generationId"]).get().to_dict()
        self.assertIsNone(stored["taskId"])
        self.assertEqual(stored["status"], "SUBMITTING")
        ops.link_face_swap_task(self.uid, record["generationId"], grant["submissionAttemptId"], task_id)
        self.balances(5, 2)

    def test_concurrent_success_charges_once(self):
        record, _, task_id = self.linked()
        with patch.object(ops, "_fetch_face_swap_task", AsyncMock(return_value={"taskId": task_id, "taskStatus": "SUCCEEDED"})):
            results = self.parallel(lambda _: self.finalize(record, "SUCCEEDED"))
            self.assertTrue(all(r["creditStatus"] == "charged" for r in results))
            self.finalize(record, "SUCCEEDED")
        self.balances(3, 0)

    def test_concurrent_failure_releases_once(self):
        record, _, task_id = self.linked()
        with patch.object(ops, "_fetch_face_swap_task", AsyncMock(return_value={"taskId": task_id, "taskStatus": "FAILED"})):
            results = self.parallel(lambda _: self.finalize(record, "FAILED"))
            self.assertTrue(all(r["creditStatus"] == "released" for r in results))
            self.finalize(record, "FAILED")
        self.balances(5, 0)

    def test_conflicting_terminal_confirmations_never_reverse(self):
        record, _, task_id = self.linked()
        # Exercise independent real transactions with opposite trusted evidence.
        def finish(index):
            return ops._finalize_confirmed_task(client.transaction(), self.uid, record["generationId"],
                                                task_id, "SUCCEEDED" if index == 0 else "FAILED")
        self.parallel(finish)
        stored = client.collection("generations").document(record["generationId"]).get().to_dict()
        self.assertIn(stored["creditStatus"], ("charged", "released"))
        self.assertEqual(stored["lastConflictingStatus"], "FAILED" if stored["creditStatus"] == "charged" else "SUCCEEDED")
        self.balances(3 if stored["creditStatus"] == "charged" else 5, 0)
        finish(0)
        finish(1)
        final = client.collection("generations").document(record["generationId"]).get().to_dict()
        self.assertEqual(final["creditStatus"], stored["creditStatus"])

    def test_failed_finalization_has_no_partial_debit_and_recovers(self):
        record, _, task_id = self.linked()
        original = ops.finalize_generation_in_transaction
        def fail(*args):
            original(*args)
            raise RuntimeError("injected after queued financial writes")
        with patch.object(ops, "finalize_generation_in_transaction", fail):
            with self.assertRaises(RuntimeError):
                ops._finalize_confirmed_task(client.transaction(), self.uid, record["generationId"], task_id, "SUCCEEDED")
        self.balances(5, 2)
        stored = client.collection("generations").document(record["generationId"]).get().to_dict()
        self.assertEqual(stored["creditStatus"], "reserved")
        ops._finalize_confirmed_task(client.transaction(), self.uid, record["generationId"], task_id, "SUCCEEDED")
        self.balances(3, 0)

    def test_same_task_cannot_bind_two_operations(self):
        records = [self.reserve("op-" + str(index)) for index in range(2)]
        grants = [ops.acquire_face_swap_submission(self.uid, r["generationId"]) for r in records]
        task_id = self.task_id()
        def link(index):
            try:
                return ops.link_face_swap_task(self.uid, records[index]["generationId"], grants[index]["submissionAttemptId"], task_id)
            except ops.ReservationConflict:
                return None
        results = self.parallel(link)
        self.assertEqual(sum(value is not None for value in results), 1)
        owner = client.collection("face_swap_tasks").document(task_id).get().to_dict()
        self.assertEqual(owner["generationId"], next(r for r in results if r)["generationId"])
        self.balances(5, 4)


if __name__ == "__main__":
    unittest.main()
