"""Offline tests: no Firebase initialization or provider requests.

Run: Backend/venv/bin/python -B -m unittest discover -s Backend/tests -v
"""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient


BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def load_module(name, relative):
    spec = importlib.util.spec_from_file_location(name, BACKEND / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


with patch("dotenv.load_dotenv"):
    provider = load_module("tested_deepswap", "app/services/deepswap.py")

firebase = types.ModuleType("app.services.firebase")
firebase.db = Mock()
credits = types.ModuleType("app.services.generation_credits")
for name in (
    "reserve_generation_credits", "attach_generation_task",
    "charge_reserved_generation", "release_reserved_generation",
    "get_generation_by_task_for_user",
):
    setattr(credits, name, Mock())
with patch.dict(sys.modules, {
    "app.services.firebase": firebase,
    "app.services.generation_credits": credits,
    "app.services.deepswap": provider,
}):
    routes = load_module("tested_video_routes", "app/routes/video_generation.py")


class ImageToVideoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.reserve = Mock(return_value={"generationId": "generation"})
        self.release = Mock()
        self.attach = Mock()
        self.charge = Mock()
        for name, mock in (
            ("prepare_video_reference", Mock(return_value="signed-reference")),
            ("reserve_generation_credits", self.reserve),
            ("release_reserved_generation", self.release),
            ("attach_generation_task", self.attach),
            ("charge_reserved_generation", self.charge),
        ):
            patcher = patch.object(routes, name, mock)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def create(self, callback, mode="image-to-video", duration=5):
        return await routes.create_reserved_video(
            "user", mode, duration, callback, "image", "prompt", duration
        )

    async def test_payload_for_each_duration(self):
        for duration in (5, 10, 15):
            with patch.object(provider, "post", AsyncMock(return_value={})) as post:
                await provider.create_image_to_video_task("image", "prompt", duration)
                post.assert_awaited_once_with(
                    "/openapi/v1/aigc/video-generation/tasks",
                    {"model": "deepvid3.0-i2v", "prompt": "prompt",
                     "duration": duration, "outputAudio": True,
                     "media": [{"type": "firstFrame", "url": "image"}]},
                )

    async def test_success_reserves_same_price_and_attaches_without_charging(self):
        for duration in (5, 10, 15):
            result = await self.create(AsyncMock(return_value={"taskId": "123"}), duration=duration)
            self.assertEqual(result, {"taskId": "123"})
            self.assertEqual(self.reserve.call_args.args[2], duration / 5 * 1.2)
        self.attach.assert_called_with("generation", "123")
        self.release.assert_not_called()
        self.charge.assert_not_called()

    async def test_definitive_rejections_release_and_return_controlled_error(self):
        for status in (400, 401, 403, 422, 429):
            with self.subTest(status=status):
                response = httpx.Response(status, request=httpx.Request("POST", "https://provider.invalid"))
                error = httpx.HTTPStatusError("sensitive provider detail", request=response.request, response=response)
                with self.assertRaises(routes.HTTPException) as caught:
                    await self.create(AsyncMock(side_effect=error))
                self.assertEqual(caught.exception.status_code, 502)
                self.assertNotIn("sensitive", caught.exception.detail)
        self.assertEqual(self.release.call_count, 5)
        self.attach.assert_not_called()
        self.charge.assert_not_called()

    async def test_ambiguous_http_errors_keep_reservation(self):
        for status in (408, 500, 503):
            response = httpx.Response(status, request=httpx.Request("POST", "https://provider.invalid"))
            error = httpx.HTTPStatusError("ambiguous", request=response.request, response=response)
            with self.assertRaises(httpx.HTTPStatusError):
                await self.create(AsyncMock(side_effect=error))
        self.release.assert_not_called()
        self.attach.assert_not_called()
        self.charge.assert_not_called()

    async def test_network_error_keeps_reservation(self):
        with self.assertRaises(httpx.ReadTimeout):
            await self.create(AsyncMock(side_effect=httpx.ReadTimeout("ambiguous")))
        self.release.assert_not_called()
        self.attach.assert_not_called()
        self.charge.assert_not_called()

    async def test_attach_failure_does_not_release_or_charge(self):
        self.attach.side_effect = RuntimeError("persistence failure")
        with self.assertRaises(RuntimeError):
            await self.create(AsyncMock(return_value={"taskId": "123"}))
        self.release.assert_not_called()
        self.charge.assert_not_called()

    async def test_other_modes_keep_existing_http_error_behavior(self):
        for mode in ("text-to-video", "reference-to-video", "video-extend"):
            response = httpx.Response(400, request=httpx.Request("POST", "https://provider.invalid"))
            error = httpx.HTTPStatusError("rejected", request=response.request, response=response)
            with self.assertRaises(httpx.HTTPStatusError):
                await self.create(AsyncMock(side_effect=error), mode=mode)
        self.assertEqual(self.release.call_count, 3)

    async def test_logs_do_not_include_media_prompt_or_response(self):
        response = httpx.Response(200, json={"taskId": "123", "secret": "response-secret"})
        response.request = httpx.Request("POST", "https://provider.invalid")
        client = AsyncMock()
        client.post.return_value = response
        output = io.StringIO()
        with patch.object(provider, "_sign", return_value=({}, "signed-body")), \
             patch.object(provider.httpx, "AsyncClient") as factory, \
             self.assertLogs(provider.logger, level="INFO") as captured:
            factory.return_value.__aenter__.return_value = client
            await provider.create_image_to_video_task("https://image.invalid/?token=media-secret", "private-prompt", 5)
        logs = "\n".join(captured.output)
        self.assertIn("200", logs)
        for secret in ("media-secret", "private-prompt", "response-secret", "signed-body"):
            self.assertNotIn(secret, logs)

    async def test_prompt_limit_before_reserving_and_http_rejection(self):
        app = FastAPI()
        app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser("user", {})
        client = TestClient(app)
        response = client.post("/video-generation/image-to-video", json={
            "image_url": "image", "prompt": "a" * 1501, "duration": 5,
        })
        self.assertEqual(response.status_code, 422)
        self.reserve.assert_not_called()
        self.assertEqual(len(routes.ImageToVideoRequest(image_url="image", prompt="a" * 1500, duration=5).prompt), 1500)
        rejection = httpx.Response(400, request=httpx.Request("POST", "https://provider.invalid"))
        error = httpx.HTTPStatusError("sensitive", request=rejection.request, response=rejection)
        with patch.object(routes, "create_image_to_video_task", AsyncMock(side_effect=error)):
            response = client.post("/video-generation/image-to-video", json={
                "image_url": "image", "prompt": "prompt", "duration": 5,
            })
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("sensitive", response.text)
        self.release.assert_called_once_with("generation")

    async def test_invalid_duration_before_reservation(self):
        with self.assertRaises(routes.HTTPException) as caught:
            await self.create(AsyncMock(), duration=6)
        self.assertEqual(caught.exception.status_code, 400)
        self.reserve.assert_not_called()

    async def test_task_completion_keeps_charge_and_release_rules(self):
        user = routes.AuthenticatedUser("user", {})
        for status in ("PENDING", "RUNNING", "SUCCEEDED", "FAILED"):
            self.charge.reset_mock()
            self.release.reset_mock()
            with patch.object(routes, "get_generation_by_task_for_user", return_value={
                "generationId": "generation", "type": "video-generation",
            }), patch.object(routes, "get_video_task", AsyncMock(return_value={"taskStatus": status})):
                await routes.get_video_generation_task("123", user)
            if status == "SUCCEEDED":
                self.charge.assert_called_once_with("generation")
                self.release.assert_not_called()
            elif status == "FAILED":
                self.release.assert_called_once_with("generation")
                self.charge.assert_not_called()
            else:
                self.charge.assert_not_called()
                self.release.assert_not_called()


if __name__ == "__main__":
    unittest.main()
