"""Offline shared video status route with real transactional credit primitives."""
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

import test_image_to_video as fixtures
import test_face_swap_operations as finance

routes = fixtures.routes
credits = finance.credits


class VideoTaskFailureTests(unittest.TestCase):
    def setUp(self):
        self.fail_commit = False
        self.state = {
            ('users', 'alice'): {'credits': 10.0, 'reservedCredits': 2.0},
            ('generations', 'r2v-operation'): {
                'generationId': 'r2v-operation', 'userId': 'alice', 'taskId': '123',
                'type': 'video-generation', 'mode': 'reference-to-video', 'cost': 2.0,
                'creditStatus': 'reserved', 'status': 'PROCESSING',
            },
        }
        case = self
        class Reference(finance.Reference):
            def get(self, *, transaction=None):
                data = (transaction.state if transaction else case.state).get(self.key)
                return Mock(exists=data is not None, to_dict=lambda: deepcopy(data))
        db = Mock()
        def collection(name):
            query = Mock()
            query.document.side_effect = lambda identifier: Reference(name, identifier)
            def where(*, filter):
                matches = [Mock(id=identifier, to_dict=lambda data=deepcopy(data): data)
                           for (kind, identifier), data in case.state.items()
                           if kind == name and data.get(filter.field_path) == filter.value]
                query.limit.return_value.stream.return_value = matches[:2]
                return query
            query.where.side_effect = where
            return query
        db.collection.side_effect = collection
        original = credits._finalize
        def finalize(_transaction, *args):
            working = deepcopy(self.state)
            result = original(finance.Transaction(working), *args)
            if self.fail_commit:
                raise RuntimeError('private-diagnostic')
            self.state = working
            return result
        self.provider = AsyncMock(return_value={
            'taskId': '123', 'taskStatus': 'FAILED', 'errorCode': 'InternalError',
            'errorMsg': 'private-diagnostic', 'internal': {'token': 'private-diagnostic'},
            'videoUrl': 'https://private.invalid/nonexistent',
        })
        self.reserve, self.create = Mock(), AsyncMock()
        for p in (patch.object(credits, 'db', db), patch.object(credits, '_finalize', side_effect=finalize),
                  patch.object(routes, 'get_generation_by_task_for_user', credits.get_generation_by_task_for_user),
                  patch.object(routes, 'release_reserved_generation', credits.release_reserved_generation),
                  patch.object(routes, 'charge_reserved_generation', credits.charge_reserved_generation),
                  patch.object(routes, 'get_video_task', self.provider),
                  patch.object(routes, 'reserve_generation_credits', self.reserve),
                  patch.object(fixtures.provider, 'create_reference_to_video_task', self.create)):
            p.start(); self.addCleanup(p.stop)
        self.user = 'alice'
        app = FastAPI(); app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user] = lambda: routes.AuthenticatedUser(self.user, {})
        self.app, self.client = app, TestClient(app)

    def status(self):
        return self.client.get('/video-generation/task/123')

    def test_r2v_internal_error_releases_once_without_debit_or_result(self):
        first = self.status()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json(), {'taskId': '123', 'taskStatus': 'FAILED', 'errorMsg': 'A geração do vídeo falhou.'})
        self.assertEqual(self.state[('users', 'alice')], {'credits': 10.0, 'reservedCredits': 0.0})
        self.assertEqual(self.state[('generations', 'r2v-operation')]['creditStatus'], 'released')
        before = deepcopy(self.state)
        for _ in range(3): self.assertEqual(self.status().status_code, 200)
        self.assertEqual(self.state, before)
        self.reserve.assert_not_called(); self.create.assert_not_awaited()
        self.assertNotIn('private', first.text); self.assertNotIn('errorCode', first.text)
        self.assertNotIn('videoUrl', first.json())

    def test_identity_mismatch_or_invalid_id_never_finalizes(self):
        before = deepcopy(self.state)
        for value in ('456', True, None, [], {}):
            with self.subTest(value=value):
                self.provider.return_value['taskId'] = value
                self.assertEqual(self.status().status_code, 502)
                self.assertEqual(self.state, before)

    def test_optional_or_integer_task_id_remains_supported(self):
        for value in (None, 123):
            if value is None: self.provider.return_value.pop('taskId', None)
            else: self.provider.return_value['taskId'] = value
            self.assertEqual(self.status().status_code, 200)

    def test_commit_failure_returns_controlled_financial_uncertainty(self):
        self.fail_commit = True
        before = deepcopy(self.state)
        with self.assertLogs(routes.logger, level='WARNING') as logs:
            response = self.status()
        self.assertEqual(response.status_code, 503)
        detail = response.json()['detail']
        self.assertEqual(detail['code'], 'financial_finalization_unconfirmed')
        self.assertEqual(detail['taskStatus'], 'FAILED')
        self.assertEqual(self.state, before)
        self.assertNotIn('private-diagnostic', response.text + ' '.join(logs.output))
        self.assertNotIn('liberada', response.text)

    def test_existing_charged_or_released_terminal_is_never_overwritten(self):
        for financial, stored, provider, balance in (
            ('charged', 'SUCCEEDED', 'FAILED', 8.0),
            ('released', 'FAILED', 'SUCCEEDED', 10.0),
        ):
            self.state[('generations', 'r2v-operation')].update(creditStatus=financial, status=stored)
            self.state[('users', 'alice')].update(credits=balance, reservedCredits=0.0)
            self.provider.return_value['taskStatus'] = provider
            before = deepcopy(self.state)
            self.assertEqual(self.status().status_code, 200)
            self.assertEqual(self.state, before)

    def test_pending_running_and_success_keep_existing_behavior_for_each_mode(self):
        for mode in ('reference-to-video', 'image-to-video', 'video-extend', 'text-to-video'):
            for status in ('PENDING', 'RUNNING', 'SUCCEEDED'):
                with self.subTest(mode=mode, status=status):
                    self.state[('generations', 'r2v-operation')].update(mode=mode, creditStatus='reserved', status='PROCESSING')
                    self.state[('users', 'alice')].update(credits=10.0, reservedCredits=2.0)
                    self.provider.return_value.update(taskStatus=status, videoUrl='https://media.invalid/video.mp4')
                    response = self.status()
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()['taskStatus'], status)
                    if status == 'SUCCEEDED':
                        self.assertEqual(response.json()['videoUrl'], 'https://media.invalid/video.mp4')
                        self.assertEqual(self.state[('users', 'alice')], {'credits': 8.0, 'reservedCredits': 0.0})
                    else:
                        self.assertNotIn('videoUrl', response.json())
                        self.assertEqual(self.state[('users', 'alice')]['reservedCredits'], 2.0)
                    self.assertNotIn('errorCode', response.json())
                    self.assertNotIn('internal', response.json())

    def test_authorization_and_provider_outage_do_not_finalize(self):
        before = deepcopy(self.state)
        self.user = 'bob'
        self.assertEqual(self.status().status_code, 404)
        self.provider.assert_not_awaited()
        self.user = 'alice'
        self.provider.side_effect = httpx.ReadTimeout('private-diagnostic')
        response = self.status()
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {'detail': 'Não foi possível consultar a geração de vídeo.'})
        self.assertEqual(self.state, before)

    def test_invalid_response_never_finalizes(self):
        before = deepcopy(self.state)
        for response in (None, [], {}, {'taskStatus': 'invalid'}, {'taskStatus': []}):
            self.provider.return_value = response
            self.assertEqual(self.status().status_code, 502)
            self.assertEqual(self.state, before)
