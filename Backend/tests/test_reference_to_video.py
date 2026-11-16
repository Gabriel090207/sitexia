"""Offline R2V contract and pre-reservation validation regressions."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

import test_image_to_video as fixtures

routes = fixtures.routes


class ReferenceToVideoTests(unittest.TestCase):
    def setUp(self):
        fixtures.ImageToVideoTests.setUp(self)
        self.app = FastAPI()
        self.app.include_router(routes.router)
        self.app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser('user', {})
        self.client = TestClient(self.app)
    def post(self, prompt='prompt', duration=5):
        return self.client.post('/video-generation/reference-to-video', json={
            'reference_url': 'private-reference', 'prompt': prompt, 'duration': duration,
        })

    def test_exact_non_fast_payload_for_supported_durations(self):
        for duration in (5, 10, 15):
            with self.subTest(duration=duration), patch.object(fixtures.provider, 'post', AsyncMock()) as post:
                asyncio.run(fixtures.provider.create_reference_to_video_task('signed-reference', 'prompt', duration))
                post.assert_awaited_once_with('/openapi/v1/aigc/video-generation/tasks', {
                    'model': 'deepecho2.0-r2v', 'prompt': 'prompt', 'duration': duration,
                    'resolution': '720p', 'ratio': '16:9',
                    'media': [{'type': 'referenceImage', 'url': 'signed-reference'}],
                })

    def test_all_new_r2v_requests_are_blocked_before_any_work(self):
        with patch.object(routes, 'prepare_video_reference') as prepare, \
             patch.object(fixtures.provider, 'create_reference_to_video_task', AsyncMock()) as provider:
            for prompt in ('', 'x' * 1500):
                for duration in (5,10,15,20):
                    response=self.post(prompt,duration)
                    self.assertEqual(response.status_code,410)
            prepare.assert_not_called()
            provider.assert_not_awaited()
        self.reserve.assert_not_called();self.release.assert_not_called()
        self.charge.assert_not_called();self.attach.assert_not_called()

    def test_invalid_request_is_rejected_without_reservation(self):
        self.assertEqual(self.post('x'*1501).status_code,422)
        self.reserve.assert_not_called()

    def test_authentication_remains_required(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.post().status_code,401)
        self.reserve.assert_not_called()
