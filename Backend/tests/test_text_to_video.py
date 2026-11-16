"""Offline DeepEcho text-only contract and unchanged financial orchestration."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
import test_image_to_video as fixtures

routes = fixtures.routes


class TextToVideoTests(unittest.TestCase):
    def setUp(self):
        fixtures.ImageToVideoTests.setUp(self)
        self.provider = AsyncMock(return_value={'taskId':'123'})
        patcher=patch.object(routes,'create_text_to_video_task',self.provider)
        patcher.start(); self.addCleanup(patcher.stop)
        self.app=FastAPI(); self.app.include_router(routes.router)
        self.app.dependency_overrides[routes.get_current_user]=lambda:routes.AuthenticatedUser('user',{})
        self.client=TestClient(self.app)

    def post(self, prompt='prompt', duration=5, **extra):
        return self.client.post('/video-generation/text-to-video',json={'prompt':prompt,'duration':duration,**extra})

    def test_exact_non_fast_text_only_payload(self):
        for duration in (5,10,15):
            with patch.object(fixtures.provider,'post',AsyncMock()) as post:
                asyncio.run(fixtures.provider.create_text_to_video_task('prompt',duration))
                post.assert_awaited_once_with('/openapi/v1/aigc/video-generation/tasks',{
                    'model':'deepecho2.0-t2v','prompt':'prompt','duration':duration,'resolution':'720p',
                })

    def test_1500_and_empty_prompts_accepted_without_image_preparation(self):
        with patch.object(routes,'prepare_video_reference') as prepare:
            for prompt in ('','x'*1500):
                self.assertEqual(self.post(prompt).status_code,200)
                self.provider.assert_awaited_with(prompt,5)
            prepare.assert_not_called()

    def test_invalid_prompt_and_legacy_reference_rejected_before_reserving(self):
        with patch.object(routes,'prepare_video_reference') as prepare:
            self.assertEqual(self.post('x'*1501).status_code,422)
            self.assertEqual(self.client.post('/video-generation/text-to-video',json={'duration':5}).status_code,422)
            for reference in ('','legacy-reference'):
                self.assertEqual(self.post(reference_image_url=reference).status_code,422)
            prepare.assert_not_called()
        self.reserve.assert_not_called(); self.provider.assert_not_awaited()

    def test_existing_durations_and_costs_unchanged(self):
        for duration,cost in ((5,1.2),(10,2.4),(15,3.6)):
            self.assertEqual(self.post(duration=duration).status_code,200)
            self.assertAlmostEqual(self.reserve.call_args.args[2],cost)
            self.assertEqual(self.reserve.call_args.args[3:],('video-generation','text-to-video'))
            self.provider.assert_awaited_with('prompt',duration)
        self.release.assert_not_called(); self.charge.assert_not_called()

    def test_extra_durations_rejected_without_reservation_or_provider(self):
        for duration in (0,6,20,25,30): self.assertEqual(self.post(duration=duration).status_code,400)
        self.reserve.assert_not_called(); self.provider.assert_not_awaited()

    def test_rejections_and_ambiguous_results_keep_existing_finances_without_retry(self):
        for status in (400,408,500,503):
            self.reserve.reset_mock(); self.release.reset_mock(); self.provider.reset_mock()
            response=httpx.Response(status,request=httpx.Request('POST','https://provider.invalid'))
            self.provider.side_effect=httpx.HTTPStatusError('private-detail',request=response.request,response=response)
            result=self.post()
            self.assertEqual(result.status_code,502)
            self.assertNotIn('private-detail',result.text)
            self.reserve.assert_called_once(); self.provider.assert_awaited_once()
            if status==400:self.release.assert_called_once_with('generation')
            else:self.release.assert_not_called()
        self.attach.assert_not_called();self.charge.assert_not_called()

    def test_network_failure_preserves_reservation_without_resend(self):
        self.provider.side_effect=httpx.ReadTimeout('private-detail')
        self.assertEqual(self.post().status_code,502)
        self.provider.assert_awaited_once();self.release.assert_not_called()

    def test_authentication_remains_required(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.post().status_code,401)
        self.reserve.assert_not_called();self.provider.assert_not_awaited()
