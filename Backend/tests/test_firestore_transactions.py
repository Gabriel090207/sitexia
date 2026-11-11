"""Real SDK retry controller, fake transport: deterministic thread isolation."""
from concurrent.futures import ThreadPoolExecutor
import inspect
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

from google.api_core.exceptions import Aborted
from google.cloud.firestore_v1.base_transaction import MAX_ATTEMPTS

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.services import firestore_transactions as adapter


class RetryTransaction:
    _max_attempts = MAX_ATTEMPTS
    _read_only = False

    def __init__(self, name):
        self.name, self.ids, self.retry_ids = name, [], []
        self._id = None
        self.commits = 0

    def _clean_up(self):
        self._id = None

    def _begin(self, retry_id=None):
        expected = self.ids[0] if self.ids else None
        if retry_id != expected:
            raise AssertionError("Retry ID belongs to another invocation")
        self.retry_ids.append(retry_id)
        self._id = f"{self.name}:{len(self.ids)}".encode()
        self.ids.append(self._id)

    def _commit(self):
        self.commits += 1
        if self.commits == 1:
            raise Aborted("Synthetic first-commit contention")

    def _rollback(self):
        pass


class IsolationTests(unittest.TestCase):
    def test_shared_python_callable_has_fresh_sdk_state_for_all_20_calls(self):
        barrier = threading.Barrier(2)

        @adapter.isolated_transactional
        def operation(transaction, *, label):
            if len(transaction.ids) == 1:
                # Force overlap after both SDK wrappers have selected retry IDs.
                barrier.wait(timeout=5)
            return label

        instances = []
        original = adapter.firestore.transactional

        def factory(function):
            instance = original(function)
            instances.append(instance)
            return instance

        transactions = [RetryTransaction(str(i)) for i in range(20)]
        with patch.object(adapter.firestore, "transactional", side_effect=factory):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda tx: operation(tx, label=tx.name), transactions))
        self.assertEqual(results, [str(i) for i in range(20)])
        self.assertEqual(len({id(instance) for instance in instances}), 20)
        for transaction in transactions:
            self.assertEqual(transaction.commits, 2)
            self.assertEqual(transaction.retry_ids, [None, transaction.ids[0]])
        self.assertEqual(str(inspect.signature(operation)), "(transaction, *, label)")
        self.assertEqual(operation.__name__, "operation")
        self.assertFalse(hasattr(operation, "retry_id"))
        self.assertFalse(hasattr(operation, "current_id"))

    def test_retry_exhaustion_keeps_sdk_default_and_original_cause(self):
        class AlwaysAborted(RetryTransaction):
            def _commit(self):
                self.commits += 1
                raise Aborted("Synthetic contention")

        @adapter.isolated_transactional
        def operation(transaction):
            return "not committed"

        transaction = AlwaysAborted("one")
        with self.assertRaises(ValueError) as error:
            operation(transaction)
        self.assertEqual(transaction.commits, MAX_ATTEMPTS)
        self.assertEqual(MAX_ATTEMPTS, 5)
        self.assertIsInstance(error.exception.__cause__, Aborted)


if __name__ == "__main__":
    unittest.main()
