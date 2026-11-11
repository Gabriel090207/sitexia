"""Offline route contracts; finance integration has dedicated real-primitive tests."""
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
import test_face_swap_materials as material_tests

routes = material_tests.routes


class TaskTests(unittest.TestCase):
    def setUp(self):
        material_tests.MaterialTests.setUp(self)
        self.ref.get.return_value.to_dict.return_value = {
            "uid": "alice", "materialId": "1234567890123456789", "taskId": "9876543210987654321",
        }
        self.material["faces"] = [{"id": "5"}]
        self.task = {"taskId": "9876543210987654321", "taskStatus": "PENDING"}
        self.task_create = AsyncMock(return_value=self.task)
        self.task_get = AsyncMock(return_value=self.task)
        self.debit = Mock()  # Legacy assertions: no direct debit exists anymore.
        self.submit = AsyncMock(return_value=self.task)
        self.finalize = AsyncMock(return_value=None)
        ownership_patch = patch.dict(routes.require_task_owner.__globals__, {"db": self.db})
        ownership_patch.start()
        self.addCleanup(ownership_patch.stop)
        for target, name, value in (
            (routes, "create_task", self.task_create), (routes, "get_deep_response", self.task_get),
            (routes, "submit_face_swap", self.submit), (routes, "finalize_linked_task", self.finalize),
        ):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    login = material_tests.MaterialTests.login

    def create_task(self, headers=None, **overrides):
        body = {"material_id": "1234567890123456789", "source_face_id": "5",
                "target_face_url": "https://media.invalid/?token=private", "media_type": "image"}
        body.update(overrides)
        return self.client.post("/swap/task", json=body,
                                headers={"Idempotency-Key": "intent-1"} if headers is None else headers)

    def test_creation_delegates_finance_without_client_price(self):
        response = self.create_task(media_type="video", video_duration=999)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.task)
        args = self.submit.call_args.args
        self.assertEqual(args[:4], ("alice", "intent-1", "1234567890123456789", "5"))
        self.assertEqual(len(args), 7)
        self.task_create.assert_not_awaited()

    def test_missing_invalid_idempotency_key_rejected_without_submission(self):
        for headers in ({}, {"Idempotency-Key": "bad key"}, {"Idempotency-Key": "x" * 129}):
            self.assertEqual(self.create_task(headers=headers).status_code, 422)
        self.submit.assert_not_awaited()

    def test_authentication_and_material_ownership_required(self):
        self.login("bob")
        self.assertEqual(self.create_task().status_code, 404)
        self.submit.assert_not_awaited()
        self.app.dependency_overrides.clear()
        self.assertEqual(self.create_task().status_code, 401)

    def test_invalid_identifiers_rejected(self):
        self.assertEqual(self.create_task(material_id="-1").status_code, 400)
        self.assertEqual(self.create_task(source_face_id="1.0").status_code, 400)
        self.submit.assert_not_awaited()

    def test_status_finalizes_and_preserves_task_contract(self):
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").json(), self.task)
        self.finalize.assert_awaited_once_with("alice", "9876543210987654321")

    def test_status_uses_committed_terminal_financial_state(self):
        self.finalize.return_value = {"creditStatus": "charged", "status": "SUCCEEDED"}
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").json()["taskStatus"], "SUCCEEDED")

    def test_provider_failure_is_sanitized(self):
        self.task_get.side_effect = httpx.ReadTimeout("private-detail")
        response = self.client.get("/swap/task/9876543210987654321")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private-detail", response.text)


if __name__ == "__main__":
    unittest.main()
