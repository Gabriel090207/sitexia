"""Offline image creation errors; no Firebase initialization or provider I/O."""
import json
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
import test_image_to_video as fixtures

with patch.dict(sys.modules, {
    'app.services.firebase': fixtures.firebase,
    'app.services.generation_credits': fixtures.credits,
    'app.services.deepswap': fixtures.provider,
}):
    routes = fixtures.load_module('tested_image_creation_errors', 'app/routes/image_generation.py')

PRIVATE = 'private-prompt private-token signed-secret personal-data'


class ImageCreationErrorTests(unittest.TestCase):
    def setUp(self):
        self.reserve = Mock(return_value={'generationId':'image-operation'})
        self.release, self.attach, self.charge = Mock(), Mock(), Mock()
        self.create = AsyncMock(return_value={'taskId':'123'})
        for name,value in (
            ('reserve_generation_credits',self.reserve), ('release_reserved_generation',self.release),
            ('attach_generation_task',self.attach), ('charge_reserved_generation',self.charge),
            ('create_text_to_image_task',self.create),
        ):
            p=patch.object(routes,name,value);p.start();self.addCleanup(p.stop)
        app=FastAPI();app.include_router(routes.router)
        app.dependency_overrides[routes.get_current_user]=lambda:routes.AuthenticatedUser('alice',{})
        self.client=TestClient(app)

    def post(self,style='realistic',quantity=1,prompt=PRIVATE):
        return self.client.post('/image-generation/text-to-image',json={
            'style':style,'prompt':prompt,'quantity':quantity,
        })

    def rejection(self,status=400,content=b''):
        response=httpx.Response(status,content=content,request=httpx.Request('POST','https://provider.invalid'))
        response.json=Mock(side_effect=AssertionError('error body must not be parsed without a documented allowlist'))
        self.create.side_effect=httpx.HTTPStatusError(PRIVATE,request=response.request,response=response)
        return response

    def test_400_releases_once_and_returns_controlled_provider_error(self):
        self.rejection()
        with self.assertLogs(routes.logger,level='WARNING') as logs: result=self.post()
        self.assertEqual(result.status_code,502)
        self.assertEqual(result.json(),{'detail':'O provedor não aceitou a solicitação de geração de imagem.'})
        self.release.assert_called_once_with('image-operation')
        self.reserve.assert_called_once();self.create.assert_awaited_once()
        self.attach.assert_not_called();self.charge.assert_not_called()
        text=' '.join(logs.output)
        for safe in ('image_creation','provider_rejection','400','neoreal-girl2.0','768:1152','quantity=1'):self.assertIn(safe,text)
        self.assertNotIn(PRIVATE,text+result.text)

    def test_400_release_failure_does_not_claim_refund_or_repeat(self):
        self.rejection();self.release.side_effect=RuntimeError(PRIVATE)
        with self.assertLogs(routes.logger,level='WARNING') as logs: result=self.post()
        self.assertEqual(result.status_code,503)
        self.assertIn('não foi possível confirmar a liberação',result.json()['detail'])
        self.assertIn('Não inicie outra geração',result.json()['detail'])
        self.assertNotIn(PRIVATE,result.text+' '.join(logs.output))
        self.release.assert_called_once();self.create.assert_awaited_once();self.charge.assert_not_called()

    def test_error_bodies_are_never_exposed_or_parsed(self):
        for content in (b'',b'<html>private-token</html>',b'{malformed',json.dumps({'code':PRIVATE,'errorMsg':PRIVATE,'secret':PRIVATE}).encode()):
            with self.subTest(content_type=bool(content)):
                self.release.reset_mock();self.create.reset_mock()
                response=self.rejection(content=content)
                with self.assertLogs(routes.logger,level='WARNING') as logs: result=self.post()
                self.assertEqual(result.status_code,502)
                response.json.assert_not_called()
                self.assertNotIn('private-token',result.text+' '.join(logs.output))
                self.release.assert_called_once();self.create.assert_awaited_once()

    def test_http_408_and_5xx_preserve_reservation(self):
        for status in (408,500,502,503):
            self.create.reset_mock();self.rejection(status)
            result=self.post()
            self.assertEqual(result.status_code,502)
            self.assertIn('A tarefa ou reserva pode existir',result.json()['detail'])
            self.create.assert_awaited_once()
        self.release.assert_not_called();self.charge.assert_not_called();self.attach.assert_not_called()

    def test_network_timeout_and_invalid_json_preserve_reservation(self):
        for error in (httpx.ReadTimeout(PRIVATE),httpx.ConnectError(PRIVATE),json.JSONDecodeError(PRIVATE,'',0)):
            self.create.reset_mock();self.create.side_effect=error
            with self.assertLogs(routes.logger,level='WARNING') as logs: result=self.post()
            self.assertEqual(result.status_code,502)
            self.assertNotIn(PRIVATE,result.text+' '.join(logs.output))
            self.assertIn('Não inicie outra geração',result.json()['detail'])
            self.create.assert_awaited_once()
        self.release.assert_not_called();self.charge.assert_not_called()

    def test_other_definitive_4xx_follow_existing_release_policy(self):
        for status in (401,403,415,422,429):
            self.release.reset_mock();self.create.reset_mock();self.rejection(status)
            self.assertEqual(self.post().status_code,502)
            self.release.assert_called_once();self.create.assert_awaited_once()

    def test_realistic_success_payload_and_price_unchanged(self):
        for style,model,size in (('realistic','neoreal-girl2.0','768:1152'),):
            for quantity in (1,4,9):
                self.create.reset_mock();self.reserve.reset_mock()
                result=self.post(style,quantity)
                self.assertEqual(result.status_code,200)
                self.create.assert_awaited_once_with(PRIVATE,model,size,quantity)
                self.assertAlmostEqual(self.reserve.call_args.args[2],quantity*0.2)
        self.release.assert_not_called();self.charge.assert_not_called()
        self.attach.assert_called_with('image-operation','123')

    def test_local_validation_stays_400_without_reservation(self):
        for args in ({'style':'unknown'},{'quantity':2},{'prompt':' '}):
            self.assertEqual(self.post(**args).status_code,400)
        self.reserve.assert_not_called();self.create.assert_not_awaited();self.release.assert_not_called()


    def test_anime_is_explicitly_blocked_before_reservation_or_provider(self):
        for quantity in (1,4,9):
            self.assertEqual(self.post(style='anime',quantity=quantity).status_code,410)
        self.reserve.assert_not_called();self.create.assert_not_awaited()
        self.release.assert_not_called();self.charge.assert_not_called();self.attach.assert_not_called()


    def test_historical_image_task_query_remains_available(self):
        with patch.object(routes, 'get_generation_by_task_for_user', return_value={
            'generationId':'historic-anime', 'type':'image-generation',
        }), patch.object(routes, 'get_task', AsyncMock(return_value={
            'taskId':'123', 'taskStatus':'SUCCEEDED', 'imageUrls':['https://media.invalid/image'],
        })) as query:
            response=self.client.get('/image-generation/task/123')
        self.assertEqual(response.status_code,200)
        query.assert_awaited_once_with('123')
        self.charge.assert_called_once_with('historic-anime')
        self.reserve.assert_not_called();self.create.assert_not_awaited()
