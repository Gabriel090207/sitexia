"""Task authorization tests, with no provider or production database access."""
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from google.api_core.exceptions import AlreadyExists

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
        self.debit = Mock()
        for target, name, value in (
            (routes, "create_task", self.task_create),
            (routes, "get_deep_response", self.task_get),
            (routes, "deduct_credits", self.debit),
        ):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(routes.register_task_owner.__globals__, {"db": self.db})
        p.start()
        self.addCleanup(p.stop)

    login = material_tests.MaterialTests.login

    def create_task(self, **overrides):
        body = {"material_id": "1234567890123456789", "source_face_id": "5",
                "target_face_url": "https://media.invalid/?token=private", "media_type": "image"}
        body.update(overrides)
        return self.client.post("/swap/task", json=body)

    def test_legitimate_creation_and_minimal_atomic_record(self):
        events = []
        self.get.side_effect = lambda *a: events.append("material") or self.material
        self.debit.side_effect = lambda *a: events.append("debit")
        self.task_create.side_effect = lambda *a: events.append("task") or self.task
        response = self.create_task(material_id="0001234567890123456789", source_face_id="005")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.task)
        self.assertEqual(events, ["material", "debit", "task"])
        self.assertEqual(self.debit.call_args.args[2], 0.1)
        self.db.collection.assert_called_with("face_swap_tasks")
        self.db.collection.return_value.document.assert_called_with("9876543210987654321")
        data = self.ref.create.call_args.args[0]
        self.assertEqual(set(data), {"taskId", "uid", "materialId", "sourceFaceId", "createdAt"})
        self.assertEqual(data["uid"], "alice")
        self.assertEqual(data["sourceFaceId"], "5")
        self.assertEqual(data["materialId"], "1234567890123456789")
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()

    def test_authentication_required_for_both_routes(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.create_task().status_code, 401)
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").status_code, 401)
        self.task_create.assert_not_awaited()
        self.task_get.assert_not_awaited()
        self.debit.assert_not_called()

    def test_other_user_cannot_use_material_or_query_task(self):
        self.login("bob")
        self.assertEqual(self.create_task().status_code, 404)
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").status_code, 404)
        self.get.assert_not_awaited()
        self.task_get.assert_not_awaited()
        self.task_create.assert_not_awaited()
        self.debit.assert_not_called()

    def test_missing_legacy_records_denied(self):
        self.ref.get.return_value.exists = False
        self.assertEqual(self.create_task().status_code, 404)
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").status_code, 404)
        self.get.assert_not_awaited()
        self.task_get.assert_not_awaited()
        self.debit.assert_not_called()

    def test_pending_failed_material_and_wrong_face_before_debit(self):
        for status in ("PENDING", "FAILED"):
            self.material["status"] = status
            self.assertEqual(self.create_task().status_code, 409)
        self.material["status"] = "SUCCEEDED"
        self.assertEqual(self.create_task(source_face_id="6").status_code, 400)
        self.debit.assert_not_called()
        self.task_create.assert_not_awaited()

    def test_invalid_material_response_or_face_data(self):
        self.material["materialId"] = "999"
        self.assertEqual(self.create_task().status_code, 502)
        self.material["materialId"] = "1234567890123456789"
        for faces in (None, [{"id": 1.5}], [{"id": True}]):
            self.material["faces"] = faces
            self.assertEqual(self.create_task().status_code, 502)
        self.debit.assert_not_called()

    def test_invalid_identifiers_do_not_reach_provider_or_debit(self):
        self.assertEqual(self.create_task(material_id="-1").status_code, 400)
        self.assertEqual(self.create_task(source_face_id="1.0").status_code, 400)
        self.assertEqual(self.client.get("/swap/task/not-a-task").status_code, 404)
        self.get.assert_not_awaited()
        self.task_get.assert_not_awaited()
        self.debit.assert_not_called()

    def test_read_failure_closed_before_provider_or_debit(self):
        self.ref.get.side_effect = RuntimeError("private-detail")
        for response in (self.create_task(), self.client.get("/swap/task/9876543210987654321")):
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("private-detail", response.text)
        self.get.assert_not_awaited()
        self.task_get.assert_not_awaited()
        self.debit.assert_not_called()

    def test_write_failure_and_conflict_never_return_success(self):
        for error, status in ((RuntimeError("private-detail"), 503), (AlreadyExists("private-detail"), 409)):
            self.ref.create.side_effect = error
            with self.assertLogs(routes.__name__, level="WARNING") as logs:
                response = self.create_task()
            self.assertEqual(response.status_code, status)
            log = " ".join(logs.output)
            self.assertIn("9876543210987654321", log)
            self.assertIn("alice", log)
            self.assertNotIn("private-detail", log + response.text)
            self.assertNotIn("token=", log + response.text)
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()

    def test_invalid_task_id_cannot_create_association(self):
        for value in (None, True, 1.5, "abc"):
            self.task_create.return_value = {"taskId": value}
            self.assertEqual(self.create_task().status_code, 502)
        self.ref.create.assert_not_called()

    def test_owner_query_preserves_response_and_normalizes(self):
        response = self.client.get("/swap/task/0009876543210987654321")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.task)
        self.task_get.assert_awaited_once_with("/openapi/v1/tasks/9876543210987654321", log_response=False)

    def test_provider_failures_controlled_without_extra_financial_action(self):
        self.get.side_effect = httpx.ReadTimeout("private-detail")
        self.assertEqual(self.create_task().status_code, 502)
        self.debit.assert_not_called()
        self.get.side_effect = None
        self.task_create.side_effect = httpx.ReadTimeout("private-detail")
        self.assertEqual(self.create_task().status_code, 502)
        self.debit.assert_called_once()
        self.ref.create.assert_not_called()
        self.task_get.side_effect = httpx.ReadTimeout("private-detail")
        self.assertEqual(self.client.get("/swap/task/9876543210987654321").status_code, 502)


if __name__ == "__main__":
    unittest.main()
