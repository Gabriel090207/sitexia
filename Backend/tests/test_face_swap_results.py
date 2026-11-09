"""Offline authorization and response-contract tests for POST /swap/result."""
import unittest

import httpx

import test_face_swap_tasks as task_tests

routes = task_tests.routes


class ResultTests(unittest.TestCase):
    def setUp(self):
        task_tests.TaskTests.setUp(self)
        self.task.update(taskStatus="SUCCEEDED", videoUrl="https://media.invalid/video.mp4?token=private")

    login = task_tests.TaskTests.login

    def result(self, task_id="9876543210987654321"):
        return self.client.post("/swap/result", json={"task_id": task_id})

    def test_owner_video_result_preserves_contract(self):
        self.task.update(coverUrl="https://media.invalid/cover", materialId="1234567890123456789")
        response = self.result("0009876543210987654321")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "success": True, "status": "SUCCEEDED", "file_url": self.task["videoUrl"],
            "task_id": self.task["taskId"], "cover_url": self.task["coverUrl"],
            "material_id": self.task["materialId"],
        })
        self.task_get.assert_awaited_once_with("/openapi/v1/tasks/9876543210987654321", log_response=False)
        self.db.collection.assert_called_with("face_swap_tasks")
        self.debit.assert_not_called()
        self.ref.create.assert_not_called()

    def test_owner_image_result_and_optional_fields(self):
        self.task_get.return_value = {
            "taskStatus": "SUCCEEDED", "imageUrls": ["invalid", "https://media.invalid/image.png?token=private"],
        }
        response = self.result()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "success": True, "status": "SUCCEEDED", "file_url": "https://media.invalid/image.png?token=private",
        })

    def test_unauthenticated_denied_before_storage_or_provider(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.result().status_code, 401)
        self.task_get.assert_not_awaited()
        self.db.collection.assert_not_called()

    def test_other_user_denied(self):
        self.login("bob")
        response = self.result()
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json(), {"detail": "Tarefa não encontrada."})
        self.task_get.assert_not_awaited()

    def test_missing_and_legacy_task_denied(self):
        for label in ("missing", "legacy_without_binding"):
            with self.subTest(case=label):
                self.ref.get.return_value.exists = False
                self.assertEqual(self.result().json(), {"detail": "Tarefa não encontrada."})
                self.assertEqual(self.result().status_code, 404)
        self.task_get.assert_not_awaited()

    def test_invalid_ids_denied_before_provider(self):
        for value in ("0", "-1", "1.5", "abc", "１２３"):
            self.assertEqual(self.result(value).status_code, 404)
        self.task_get.assert_not_awaited()
        self.db.collection.assert_not_called()

    def test_firestore_failure_is_closed_and_sanitized(self):
        self.ref.get.side_effect = RuntimeError("private-token-and-personal-data")
        with self.assertLogs(level="WARNING") as logs:
            response = self.result()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private-token-and-personal-data", response.text + " ".join(logs.output))
        self.task_get.assert_not_awaited()

    def test_existing_task_states_preserved(self):
        for state, code in (("PENDING", 409), ("RUNNING", 409), ("FAILED", 422), ("UNKNOWN", 502)):
            self.task["taskStatus"] = state
            self.assertEqual(self.result().status_code, code)
        self.debit.assert_not_called()

    def test_provider_error_and_missing_result_preserved(self):
        self.task_get.side_effect = httpx.ReadTimeout("private-token")
        response = self.result()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private-token", response.text)
        self.task_get.side_effect = None
        self.task_get.return_value = {"taskStatus": "SUCCEEDED", "imageUrls": []}
        self.assertEqual(self.result().status_code, 502)


if __name__ == "__main__":
    unittest.main()
