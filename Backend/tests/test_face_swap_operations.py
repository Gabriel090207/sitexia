"""Mock transaction tests. No production clients, provider calls or credentials."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import threading
import unittest
from unittest.mock import Mock, patch

import test_face_swap_materials as helpers


with patch.dict(helpers.sys.modules, {"app.services.firebase": helpers.firebase}), \
     patch("app.services.firestore_transactions.isolated_transactional", side_effect=lambda function: function):
    credits = helpers.load("tested_operation_credits", "app/services/generation_credits.py")
with patch.dict(helpers.sys.modules, {
    "app.services.firebase": helpers.firebase,
    "app.services.face_swap_materials": helpers.ownership,
    "app.services.generation_credits": credits,
}), patch("app.services.firestore_transactions.isolated_transactional", side_effect=lambda function: function):
    operations = helpers.load("tested_swap_operations", "app/services/face_swap_operations.py")


class Reference:
    def __init__(self, collection, identifier):
        self.key = (collection, identifier)

    def get(self, *, transaction):
        data = transaction.state.get(self.key)
        return Mock(exists=data is not None, to_dict=lambda: deepcopy(data))


class Transaction:
    def __init__(self, state):
        self.state = state

    def create(self, reference, data):
        if reference.key in self.state:
            raise RuntimeError("conflict")
        self.state[reference.key] = deepcopy(data)

    def update(self, reference, data):
        self.state[reference.key].update(deepcopy(data))


class OperationTests(unittest.TestCase):
    def setUp(self):
        self.state = {("users", "alice"): {"credits": 5.0, "reservedCredits": 0.0},
                      ("users", "bob"): {"credits": 5.0, "reservedCredits": 0.0}}
        self.lock = threading.Lock()
        self.fail_commit = False
        db = Mock()
        db.collection.side_effect = lambda name: Mock(document=lambda identifier: Reference(name, identifier))
        original = credits._reserve

        def atomic_reserve(_transaction, *args):
            # Simulate serializable atomic commit and rollback; not a Firestore
            # contention emulator. Exceptions discard all provisional writes.
            with self.lock:
                working = deepcopy(self.state)
                result = original(Transaction(working), *args)
                if self.fail_commit:
                    raise RuntimeError("simulated unavailable storage")
                self.state = working
                return result

        for p in (patch.object(credits, "db", db), patch.object(credits, "_reserve", side_effect=atomic_reserve)):
            p.start()
            self.addCleanup(p.stop)

    def reserve(self, **overrides):
        args = dict(uid="alice", operation_id="operation-1", material_id="123", source_face_id="5",
                    target_identity="users/alice/face.png@version-1",
                    material={"materialId": "123", "materialType": "VIDEO", "duration": 16})
        args.update(overrides)
        return operations.reserve_face_swap_operation(**args)

    def test_valid_reservation_and_audit_record_without_debit(self):
        record = self.reserve()
        self.assertEqual(record["cost"], 2.0)
        self.assertEqual(record["userId"], "alice")
        self.assertEqual(record["type"], "face-swap")
        self.assertEqual(record["status"], "CREATED")
        self.assertEqual(record["creditStatus"], "reserved")
        self.assertIsNone(record["taskId"])
        self.assertIn("createdAt", record)
        self.assertIn("updatedAt", record)
        intent = record["reservationIntent"]
        self.assertEqual(intent["materialId"], "123")
        self.assertEqual(intent["sourceFaceId"], "5")
        self.assertEqual(intent["operationId"], "operation-1")
        self.assertEqual(intent["model"], "shapetransformer3.1-fs")
        self.assertEqual(intent["priceVersion"], operations.PRICE_VERSION)
        self.assertEqual(len(intent["targetIdentityHash"]), 64)
        self.assertNotIn("users/alice/face.png", str(record))
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 2.0})

    def test_insufficient_balance_has_no_partial_writes(self):
        self.state[("users", "alice")]["credits"] = 1
        before = deepcopy(self.state)
        with self.assertRaises(operations.InsufficientCredits):
            self.reserve()
        self.assertEqual(self.state, before)

    def test_partially_reserved_balance(self):
        self.state[("users", "alice")]["reservedCredits"] = 3
        self.reserve()
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 5.0})
        with self.assertRaises(operations.InsufficientCredits):
            self.reserve(operation_id="other")

    def test_repeat_uses_same_record_without_extra_hold(self):
        first = self.reserve()
        self.assertEqual(self.reserve(material_id="000123", source_face_id="005"), first)
        self.assertEqual(self.state[("users", "alice")]["reservedCredits"], 2)
        self.assertEqual(len(self.state), 3)

    def test_conflicting_intent_even_with_same_price(self):
        self.reserve()
        before = deepcopy(self.state)
        for change in (
            {"source_face_id": "6"},
            {"target_identity": "other-object@version-2"},
            {"material_id": "124", "material": {"materialId": "124", "materialType": "VIDEO", "duration": 16}},
            {"material": {"materialId": "123", "materialType": "VIDEO", "duration": 17}},
        ):
            with self.subTest(change=change), self.assertRaises(operations.ReservationConflict):
                self.reserve(**change)
        self.assertEqual(self.state, before)

    def test_users_have_independent_keys_and_cannot_replace_owner(self):
        alice = self.reserve()
        bob = self.reserve(uid="bob")
        self.assertNotEqual(alice["generationId"], bob["generationId"])
        self.assertEqual(bob["userId"], "bob")
        key = ("generations", alice["generationId"])
        self.state[key]["userId"] = "bob"  # Corrupt/conflicting association must fail closed.
        before = deepcopy(self.state)
        with self.assertRaises(operations.ReservationConflict):
            self.reserve()
        self.assertEqual(self.state, before)

    def test_transaction_failure_rolls_back_both_writes(self):
        before = deepcopy(self.state)
        self.fail_commit = True
        with self.assertRaises(RuntimeError):
            self.reserve()
        self.assertEqual(self.state, before)
        self.fail_commit = False
        self.reserve()
        self.assertEqual(self.state[("users", "alice")]["reservedCredits"], 2)

    def test_simulated_concurrent_same_operation_reserves_once(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.reserve(), range(8)))
        self.assertEqual(len({r["generationId"] for r in results}), 1)
        self.assertEqual(self.state[("users", "alice")]["reservedCredits"], 2)

    def test_simulated_concurrent_operations_cannot_overspend(self):
        def attempt(index):
            try:
                self.reserve(operation_id=f"operation-{index}")
                return True
            except operations.InsufficientCredits:
                return False
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(attempt, range(8)))
        self.assertEqual(sum(results), 2)
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 4.0})

    def test_terminal_operation_does_not_reserve_again(self):
        record = self.reserve()
        for terminal in ("charged", "released"):
            self.state[("generations", record["generationId"])]["creditStatus"] = terminal
            before = deepcopy(self.state)
            self.assertEqual(self.reserve()["creditStatus"], terminal)
            self.assertEqual(self.state, before)

    def test_image_price_and_invalid_inputs(self):
        self.assertEqual(self.reserve(material={"materialId": "123", "materialType": "IMAGE"})["cost"], 0.1)
        for change in ({"operation_id": ""}, {"target_identity": "https://media.invalid/?token=private"},
                       {"model": "other"}, {"material_id": "-1"},
                       {"material": {"materialId": "999", "materialType": "IMAGE"}}):
            with self.assertRaises(ValueError):
                self.reserve(**change)

    def test_legacy_reservations_keep_existing_shape(self):
        result = credits.reserve_generation_credits("alice", "legacy", 0.2, "image-generation", "text-to-image")
        self.assertNotIn("reservationIntent", result)
        self.assertEqual(credits.reserve_generation_credits("alice", "legacy", 0.2, "image-generation", "text-to-image"), result)


if __name__ == "__main__":
    unittest.main()
