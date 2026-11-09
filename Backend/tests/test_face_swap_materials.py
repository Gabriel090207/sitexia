"""Offline material authorization tests; Firebase and DeepSwap are mocked."""
import importlib.util
import contextlib
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore  # Load protobuf modules before scoped sys.modules patches.
import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


firebase = types.ModuleType("app.services.firebase")
firebase.db = Mock()
with patch.dict(sys.modules, {"app.services.firebase": firebase}):
    ownership = load("tested_material_ownership", "app/services/face_swap_materials.py")
with patch("dotenv.load_dotenv"):
    provider = load("tested_material_provider", "app/services/deepswap.py")
with patch.dict(sys.modules, {
    "app.services.firebase": firebase,
    "app.services.face_swap_materials": ownership,
    "app.services.deepswap": provider,
}):
    routes = load("tested_material_routes", "app/routes/swap.py")


class MaterialTests(unittest.TestCase):
    def setUp(self):
        self.db = Mock()
        self.ref = self.db.collection.return_value.document.return_value
        self.ref.get.return_value.exists = True
        self.ref.get.return_value.to_dict.return_value = {
            "uid": "alice", "materialId": "1234567890123456789",
        }
        self.material = {"materialId": "1234567890123456789", "status": "SUCCEEDED", "faces": []}
        self.create = AsyncMock(return_value=self.material)
        self.get = AsyncMock(return_value=self.material)
        for target, name, value in (
            (ownership, "db", self.db),
            (routes, "create_material", self.create),
            (routes, "get_material", self.get),
        ):
            p = patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.client = TestClient(self.app)
        self.login("alice")

    def login(self, uid):
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser(uid, {})

    def test_create_records_minimal_owner_and_preserves_response(self):
        response = self.client.post("/swap/material", json={"image_url": "https://media.invalid/?token=private"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.material)
        self.db.collection.assert_called_with("face_swap_materials")
        self.db.collection.return_value.document.assert_called_with(self.material["materialId"])
        data = self.ref.create.call_args.args[0]
        self.assertEqual(set(data), {"uid", "materialId", "createdAt"})
        self.assertEqual(data["uid"], "alice")
        self.assertEqual(data["materialId"], self.material["materialId"])
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()

    def test_owner_can_query_canonical_id_without_precision_loss(self):
        response = self.client.get("/swap/material/0001234567890123456789")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), self.material)
        self.get.assert_awaited_once_with("1234567890123456789")

    def test_other_user_denied_without_provider_call(self):
        self.login("bob")
        response = self.client.get("/swap/material/1234567890123456789")
        self.assertEqual(response.status_code, 404)
        self.get.assert_not_awaited()

    def test_missing_and_legacy_material_denied(self):
        self.ref.get.return_value.exists = False
        response = self.client.get("/swap/material/1234567890123456789")
        self.assertEqual(response.status_code, 404)
        self.get.assert_not_awaited()

    def test_no_authentication(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.client.get("/swap/material/123").status_code, 401)
        self.assertEqual(self.client.post("/swap/material", json={"image_url": "image"}).status_code, 401)
        self.create.assert_not_awaited()
        self.get.assert_not_awaited()
        self.db.collection.assert_not_called()

    def test_read_failure_is_closed_and_sanitized(self):
        self.ref.get.side_effect = RuntimeError("internal-secret")
        response = self.client.get("/swap/material/1234567890123456789")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("internal-secret", response.text)
        self.get.assert_not_awaited()

    def test_write_failure_reports_orphan_without_success_or_secrets(self):
        self.ref.create.side_effect = RuntimeError("internal-secret")
        with self.assertLogs(routes.__name__, level="WARNING") as logs:
            response = self.client.post("/swap/material", json={"image_url": "https://media.invalid/?token=private"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("internal-secret", response.text)
        log = " ".join(logs.output)
        self.assertIn(self.material["materialId"], log)
        self.assertIn("alice", log)
        self.assertNotIn("private", log)
        self.assertNotIn("internal-secret", log)

    def test_existing_owner_cannot_be_overwritten(self):
        self.ref.create.side_effect = AlreadyExists("existing-owner-secret")
        response = self.client.post("/swap/material", json={"image_url": "image"})
        self.assertEqual(response.status_code, 409)
        self.ref.set.assert_not_called()
        self.ref.update.assert_not_called()
        self.assertNotIn("existing-owner-secret", response.text)

    def test_invalid_ids_denied_before_storage_or_provider(self):
        for value in ("0", "-1", "1.0", "abc", "１２３"):
            with self.subTest(value=value):
                self.assertEqual(self.client.get("/swap/material/" + value).status_code, 404)
        self.get.assert_not_awaited()
        self.db.collection.assert_not_called()
        for value in (True, 1.2, None):
            with self.assertRaises(ValueError):
                ownership.normalize_material_id(value)

    def test_invalid_provider_id_not_persisted(self):
        self.create.return_value = {"materialId": 1.5}
        self.assertEqual(self.client.post("/swap/material", json={"image_url": "image"}).status_code, 502)
        self.ref.create.assert_not_called()

    def test_mismatched_response_not_returned(self):
        self.get.return_value = {"materialId": "999"}
        self.assertEqual(self.client.get("/swap/material/1234567890123456789").status_code, 502)

    def test_provider_failure_is_controlled_without_owner_write(self):
        self.create.side_effect = httpx.ReadTimeout("private-provider-detail")
        response = self.client.post("/swap/material", json={"image_url": "image"})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private-provider-detail", response.text)
        self.ref.create.assert_not_called()


class MaterialProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_material_logs_omit_request_and_response(self):
        response = httpx.Response(200, json={"materialId": "123", "url": "response-secret"},
                                  request=httpx.Request("POST", "https://provider.invalid"))
        client = AsyncMock()
        client.post.return_value = response
        output = io.StringIO()
        with patch.object(provider, "_sign", return_value=({}, "private-body")), \
             patch.object(provider.httpx, "AsyncClient") as factory, \
             contextlib.redirect_stdout(output):
            factory.return_value.__aenter__.return_value = client
            await provider.create_material("https://media.invalid/?token=private-token")
        self.assertIn("200", output.getvalue())
        for secret in ("response-secret", "private-body", "private-token"):
            self.assertNotIn(secret, output.getvalue())

    async def test_material_query_disables_response_logging(self):
        with patch.object(provider, "get", AsyncMock(return_value={})) as get:
            await provider.get_material("123")
            get.assert_awaited_once_with("/openapi/v1/face-swap/materials/123", log_response=False)


if __name__ == "__main__":
    unittest.main()
