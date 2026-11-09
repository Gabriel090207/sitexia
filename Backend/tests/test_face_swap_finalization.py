"""Offline finalization tests using the real financial primitive and mock commits."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
import test_face_swap_task_link as links

operations = links.operations
fixtures = links.fixtures


class FinalizationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        links.LinkTests.setUp(self)
        self.link()
        case = self

        class Reference(fixtures.Reference):
            def get(self, *, transaction=None):
                data = (transaction.state if transaction else case.state).get(self.key)
                return Mock(exists=data is not None, to_dict=lambda: deepcopy(data))

        db = Mock()
        db.collection.side_effect = lambda name: Mock(document=lambda identifier: Reference(name, identifier))
        original = operations._finalize_confirmed_task

        def finalize(_transaction, *args):
            with self.lock:
                state = deepcopy(self.state)
                result = original(fixtures.Transaction(state), *args)
                if self.fail_commit:
                    raise RuntimeError("simulated commit failure")
                self.state = state
                return result

        self.fetch = AsyncMock(return_value={"taskId": self.task_id, "taskStatus": "SUCCEEDED"})
        for p in (patch.object(operations, "db", db), patch.object(fixtures.credits, "db", db),
                  patch.object(operations, "_finalize_confirmed_task", side_effect=finalize),
                  patch.object(operations, "_fetch_face_swap_task", self.fetch)):
            p.start()
            self.addCleanup(p.stop)

    reserve = fixtures.OperationTests.reserve
    acquire = links.LinkTests.acquire
    link = links.LinkTests.link

    async def finish(self, uid="alice", identifier=None):
        return await operations.finalize_face_swap_operation(uid, identifier or self.identifier)

    async def test_success_charges_frozen_cost_once(self):
        # Price metadata must NOT be recalculated during finalization.
        self.state[self.key]["reservationIntent"]["duration"] = 999
        result = await self.finish()
        self.assertEqual(result["creditStatus"], "charged")
        self.assertEqual(result["status"], "SUCCEEDED")
        self.assertEqual(self.state[("users", "alice")], {"credits": 3.0, "reservedCredits": 0.0})
        before = deepcopy(self.state)
        await self.finish()
        self.assertEqual(self.state, before)

    async def test_failure_releases_once_without_debit(self):
        self.fetch.return_value["taskStatus"] = "FAILED"
        result = await self.finish()
        self.assertEqual(result["creditStatus"], "released")
        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(self.state[("users", "alice")], {"credits": 5.0, "reservedCredits": 0.0})
        before = deepcopy(self.state)
        await self.finish()
        self.assertEqual(self.state, before)

    async def test_pending_running_unknown_keep_reserve(self):
        before = deepcopy(self.state)
        for status in ("PENDING", "RUNNING", "UNKNOWN"):
            self.fetch.return_value["taskStatus"] = status
            self.assertEqual((await self.finish())["creditStatus"], "reserved")
            self.assertEqual(self.state, before)

    async def test_terminal_conflicts_recorded_without_movement(self):
        for first, conflicting in (("SUCCEEDED", "FAILED"), ("FAILED", "SUCCEEDED")):
            # Restore linked operation for each independent terminal sequence.
            self.state[self.key]["creditStatus"] = "reserved"
            self.state[self.key]["status"] = "PROCESSING"
            self.state[("users", "alice")] = {"credits": 5.0, "reservedCredits": 2.0}
            self.fetch.return_value["taskStatus"] = first
            await self.finish()
            user = deepcopy(self.state[("users", "alice")])
            self.fetch.return_value["taskStatus"] = conflicting
            await self.finish()
            self.assertEqual(self.state[("users", "alice")], user)
            self.assertEqual(self.state[self.key]["status"], first)
            self.assertEqual(self.state[self.key]["lastConflictingStatus"], conflicting)

    async def test_mismatched_or_incomplete_provider_response_never_releases(self):
        before = deepcopy(self.state)
        for response in ({"taskId": "999", "taskStatus": "SUCCEEDED"},
                         {"taskId": True, "taskStatus": "FAILED"}, {}, None,
                         {"taskStatus": "INVALID"}, {"taskStatus": []}):
            self.fetch.return_value = response
            with self.assertRaises(operations.InvalidFaceSwapEvidence):
                await self.finish()
            self.assertEqual(self.state, before)

    async def test_provider_id_can_be_absent(self):
        self.fetch.return_value = {"taskStatus": "SUCCEEDED"}
        self.assertEqual((await self.finish())["creditStatus"], "charged")

    async def test_missing_or_wrong_uid_denied_before_fetch(self):
        for uid, identifier in (("bob", self.identifier), ("alice", "0" * 64)):
            with self.assertRaises(operations.FaceSwapOperationNotFound):
                await self.finish(uid, identifier)
        self.fetch.assert_not_awaited()

    async def test_invalid_cost_and_reserve_leave_state_unchanged(self):
        original = deepcopy(self.state)
        for cost in (0, -1, True, float("nan"), None):
            self.state = deepcopy(original)
            self.state[self.key]["cost"] = cost
            with self.assertRaises(operations.InvalidFaceSwapEvidence):
                await self.finish()
            self.assertEqual(self.state[("users", "alice")], original[("users", "alice")])
        self.state = deepcopy(original)
        self.state[("users", "alice")]["reservedCredits"] = 1
        before = deepcopy(self.state)
        with self.assertRaises(ValueError):
            await self.finish()
        self.assertEqual(self.state, before)

    async def test_legacy_unlinked_submitting_or_wrong_owner_record_not_finalized(self):
        original = deepcopy(self.state)
        for change in ({"taskId": None, "status": "SUBMITTING"}, {"type": "video-generation"}):
            self.state = deepcopy(original)
            self.state[self.key].update(change)
            with self.assertRaises(operations.InvalidFaceSwapEvidence):
                await self.finish()
            self.fetch.assert_not_awaited()
        for owner in (None, {"uid": "alice", "taskId": self.task_id},
                      {**original[self.task_key], "generationId": "other"}):
            self.state = deepcopy(original)
            if owner is None:
                del self.state[self.task_key]
            else:
                self.state[self.task_key] = owner
            before = deepcopy(self.state)
            with self.assertRaises(operations.InvalidFaceSwapEvidence):
                await self.finish()
            self.assertEqual(self.state, before)

    async def test_transport_http_and_parsing_failures_never_release(self):
        import json
        response = httpx.Response(503, request=httpx.Request("GET", "https://provider.invalid"))
        before = deepcopy(self.state)
        for error in (httpx.ReadTimeout("private"),
                      httpx.HTTPStatusError("private", request=response.request, response=response),
                      json.JSONDecodeError("invalid", "", 0)):
            self.fetch.side_effect = error
            with self.assertRaises(type(error)):
                await self.finish()
            self.assertEqual(self.state, before)

    async def test_commit_failure_rolls_back_and_retry_is_safe(self):
        before = deepcopy(self.state)
        self.fail_commit = True
        with self.assertRaises(RuntimeError):
            await self.finish()
        self.assertEqual(self.state, before)
        self.fail_commit = False
        await self.finish()
        self.assertEqual(self.state[("users", "alice")]["credits"], 3)

    async def test_simulated_concurrent_terminal_queries_move_funds_once(self):
        for status, credits in (("SUCCEEDED", 3), ("FAILED", 5)):
            self.state[self.key]["creditStatus"] = "reserved"
            self.state[self.key]["status"] = "PROCESSING"
            self.state[("users", "alice")] = {"credits": 5.0, "reservedCredits": 2.0}
            self.fetch.return_value["taskStatus"] = status
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: asyncio.run(self.finish()), range(8)))
            self.assertEqual(len(results), 8)
            self.assertEqual(self.state[("users", "alice")], {"credits": credits, "reservedCredits": 0.0})

    async def test_shared_legacy_finalizer_preserves_other_generator_behavior(self):
        for generation_type in ("image-generation", "video-generation"):
            for charge in (True, False):
                state = deepcopy(self.state)
                state[self.key]["type"] = generation_type
                state[self.key].pop("reservationIntent")
                transaction = fixtures.Transaction(state)
                result = fixtures.credits._finalize(transaction, self.identifier, charge)
                self.assertEqual(result["creditStatus"], "charged" if charge else "released")
                self.assertEqual(state[("users", "alice")], {
                    "credits": 3.0 if charge else 5.0, "reservedCredits": 0.0,
                })
                before = deepcopy(state)
                fixtures.credits._finalize(transaction, self.identifier, charge)
                self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
