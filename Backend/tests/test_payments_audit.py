"""Offline Orders/webhook audit. Real routes/SDK adapter, no actual MP package/client."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import importlib.util
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

sdk = Mock()
class RequestOptions:
    pass
firebase = types.ModuleType('app.services.firebase'); firebase.db = Mock()
with patch.dict(sys.modules, {'app.config.mp': types.SimpleNamespace(mp_sdk=sdk),
        'mercadopago': types.ModuleType('mercadopago'),
        'mercadopago.config': types.SimpleNamespace(RequestOptions=RequestOptions)}):
    provider = load('tested_payment_provider', 'app/services/mercado_pago_orders.py')
with patch.dict(sys.modules, {'app.services.firebase': firebase, 'app.services.mercado_pago_orders': provider}), \
     patch('app.services.firestore_transactions.isolated_transactional', side_effect=lambda fn: fn):
    topups = load('tested_payment_topups', 'app/routes/topups.py')
    webhook = load('tested_payment_webhook', 'app/routes/mercado_pago_webhook.py')


class Ref:
    def __init__(self, db, path): self.db, self.path, self.id = db, path, path.split('/')[-1]
    def collection(self, name): return Collection(self.db, self.path + '/' + name)
    def get(self):
        data = deepcopy(self.db.data.get(self.path))
        return types.SimpleNamespace(exists=data is not None, to_dict=lambda: data, reference=self)
    def set(self, data): self.db.data[self.path] = deepcopy(data)
class Collection:
    def __init__(self, db, path): self.db, self.path = db, path
    def document(self, name=None):
        if name is None: self.db.counter += 1; name = 'auto-' + str(self.db.counter)
        return Ref(self.db, self.path + '/' + name)
    def where(self, *, filter): self.filter = filter; return self
    def limit(self, size): self.size = size; return self
    def stream(self):
        return [Ref(self.db, key).get() for key, data in self.db.data.items()
                if key.rsplit('/', 1)[0] == self.path and data.get(self.filter.field_path) == self.filter.value][:self.size]
class Tx:
    def __init__(self, db): self.db = db
    def get(self, ref): return iter([ref.get()])
    def update(self, ref, data): self.db.data[ref.path].update(deepcopy(data))
    def create(self, ref, data):
        if ref.path in self.db.data: raise RuntimeError('duplicate')
        ref.set(data)
    def set(self, ref, data): ref.set(data)
class DB:
    def __init__(self): self.data = {}; self.counter = 0
    def collection(self, name): return Collection(self, name)
    def transaction(self): return Tx(self)


class PaymentTests(unittest.TestCase):
    def setUp(self):
        self.db = DB(); self.lock = threading.RLock(); self.fail_grant = False
        self.db.data = {'users/alice': {'credits': 1.5, 'reservedCredits': 0.5}, 'users/bob': {'credits': 0},
            'topups/topup': {'uid': 'alice', 'package_id': 'starter', 'package_name': 'Starter', 'amount': 129.90,
                'currency': 'BRL', 'credits': 12, 'status': 'payment_pending', 'credits_granted': False},
            'topups/topup/payment_attempts/attempt': {'uid': 'alice', 'topup_id': 'topup', 'payment_method': 'pix',
                'status': 'payment_pending', 'mercado_pago_order_id': 'ORD123', 'mercado_pago_payment_id': 'PAY123'}}
        self.order = {'id': 'ORD123', 'external_reference': 'topup', 'total_amount': '129.90', 'currency_id': 'BRL',
            'status': 'processed', 'status_detail': 'accredited', 'transactions': {'payments': [
                {'id': 'PAY123', 'payment_method': {'id': 'pix', 'type': 'bank_transfer'}}]}}
        self.get_order = Mock(side_effect=lambda _: deepcopy(self.order))
        self.uid = 'alice'
        # Serializable test commits with rollback. Real transaction behavior tested separately in emulator.
        def atomic(fn, grant=False):
            def call(*args, **kwargs):
                with self.lock:
                    before = deepcopy(self.db.data)
                    try:
                        result = fn(*args, **kwargs)
                        if grant and self.fail_grant:
                            self.fail_grant = False; raise RuntimeError('synthetic commit failure')
                        return result
                    except BaseException:
                        self.db.data = before; raise
            return call
        for module in [topups, webhook]:
            p = patch.object(module, 'db', self.db); p.start(); self.addCleanup(p.stop)
        for name in ['reconcile_order_transaction', 'grant_topup_credits_once']:
            p = patch.object(webhook, name, atomic(getattr(webhook, name), name.startswith('grant'))); p.start(); self.addCleanup(p.stop)
        p = patch.object(webhook, 'get_order', self.get_order); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'MERCADO_PAGO_WEBHOOK_SECRET': 'synthetic-webhook-secret'}); p.start(); self.addCleanup(p.stop)
        app = FastAPI(); app.include_router(webhook.router); app.include_router(topups.router)
        app.dependency_overrides[topups.get_current_user] = lambda: topups.AuthenticatedUser(self.uid, {'email': 'synthetic@example.invalid'})
        self.app, self.http = app, TestClient(app, raise_server_exceptions=False)
    def notify(self, valid=True):
        sig = hmac.new(b'synthetic-webhook-secret', b'id:ord123;request-id:synthetic;ts:123;', hashlib.sha256).hexdigest()
        return self.http.post('/webhooks/mercado-pago/orders?data.id=ORD123&type=order', headers={
            'x-request-id': 'synthetic', 'x-signature': 'ts=123,v1=' + (sig if valid else 'invalid')},
            json={'data': {'id': 'ignored-body-id'}, 'status': 'forged'})
    def test_approved_duplicate_and_concurrent_webhooks_credit_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.notify().status_code, range(2)))
        self.assertEqual(results, [200, 200]); self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.db.data['users/alice'], {'credits': 13.5, 'reservedCredits': 0.5})
        self.assertEqual(len([k for k in self.db.data if k.startswith('credit_transactions/')]), 1)
        self.assertEqual(self.db.data['users/bob']['credits'], 0)
    def test_fake_webhook_denied_before_provider(self):
        self.assertEqual(self.notify(False).status_code, 401); self.get_order.assert_not_called()
    def test_price_and_credit_fields_rejected_and_package_is_server_defined(self):
        for extra in [{'credits': 999}, {'amount': 0.01}, {'uid': 'bob'}]:
            self.assertEqual(self.http.post('/topups', json={'package_id': 'starter', **extra}).status_code, 422)
        result = self.http.post('/topups', json={'package_id': 'starter'})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(result.json()['credits'], 12); self.assertEqual(result.json()['amount'], 129.90)
        attempt = self.http.post('/topups/topup/payment-attempts', json={'payment_method': 'pix'})
        self.assertEqual(attempt.status_code, 201)
    def test_other_account_cannot_confirm_or_use_payment(self):
        self.uid = 'bob'
        self.assertEqual(self.http.get('/topups/topup/status').status_code, 404)
        self.assertEqual(self.http.post('/topups/topup/payment-attempts', json={'payment_method': 'pix'}).status_code, 404)
        self.assertEqual(self.http.post('/topups/topup/payment-attempts/attempt/order').status_code, 404)
    def test_amount_currency_reference_user_and_payment_mismatches_do_not_credit(self):
        original = deepcopy(self.order)
        cases = [{'total_amount': '1.00'}, {'currency_id': 'ARS'}, {'currency': 'BRL', 'currency_id': 'USD'},
                 {'external_reference': 'missing'}, {'id': 'ORDOTHER'}]
        for change in cases:
            self.order = {**deepcopy(original), **change}
            self.assertIn(self.notify().status_code, [404, 409])
            self.assertEqual(self.db.data['users/alice']['credits'], 1.5)
        self.order = original
        self.db.data['topups/topup/payment_attempts/attempt']['uid'] = 'bob'
        self.assertEqual(self.notify().status_code, 409)
    def test_payment_id_and_method_mismatch_do_not_credit(self):
        payment = self.order['transactions']['payments'][0]
        payment['id'] = 'OTHER'
        self.assertEqual(self.notify().status_code, 409)
        payment['id'] = 'PAY123'
        payment['payment_method'] = {'id': 'visa', 'type': 'credit_card'}
        self.assertEqual(self.notify().status_code, 409)
        self.assertEqual(self.db.data['users/alice']['credits'], 1.5)

    def test_nonapproved_states_unknown_and_refund_never_grant(self):
        for status, detail in [('action_required', 'waiting_transfer'), ('processing', 'in_process'), ('failed', 'failed'),
                               ('canceled', 'canceled'), ('refunded', 'refunded'), ('charged_back', 'unknown'), ('unknown', 'unknown')]:
            self.db.data['topups/topup']['status'] = 'payment_pending'
            self.db.data['topups/topup/payment_attempts/attempt']['status'] = 'payment_pending'
            self.order.update(status=status, status_detail=detail)
            self.assertEqual(self.notify().status_code, 200)
            self.assertEqual(self.db.data['users/alice']['credits'], 1.5)
        self.assertNotIn('credit_transactions/topup', self.db.data)
    def test_refund_after_approval_preserves_ledger_without_improvised_debit(self):
        self.assertEqual(self.notify().status_code, 200)
        self.order.update(status='refunded', status_detail='refunded')
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.db.data['topups/topup']['status'], 'refunded')
        self.assertEqual(self.db.data['users/alice']['credits'], 13.5)
    def test_grant_failure_then_retry_preserves_exactly_once_credit(self):
        self.fail_grant = True
        self.assertEqual(self.notify().status_code, 500)
        self.assertEqual(self.db.data['users/alice']['credits'], 1.5)
        self.assertNotIn('credit_transactions/topup', self.db.data)
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.db.data['users/alice']['credits'], 13.5)
    def test_provider_timeout_and_not_found_do_not_credit(self):
        for error, status in [(provider.MercadoPagoOrdersNetworkError('private-token'), 502),
                              (provider.MercadoPagoOrderNotFoundError('private-token'), 404)]:
            self.get_order.side_effect = error
            response = self.notify(); self.assertEqual(response.status_code, status)
            self.assertNotIn('private-token', response.text)
            self.assertEqual(self.db.data['users/alice']['credits'], 1.5)
    def test_completed_topup_blocks_preexisting_pix_attempt_before_provider(self):
        self.db.data['topups/topup']['credits_granted'] = True
        self.db.data['topups/topup/payment_attempts/attempt'].update(status='created', status_detail='awaiting_order_creation', mercado_pago_order_id=None)
        with patch.object(topups, 'create_order') as create:
            self.assertEqual(self.http.post('/topups/topup/payment-attempts/attempt/order').status_code, 409)
        create.assert_not_called()
    def test_network_retry_reuses_the_same_attempt_idempotency_key(self):
        attempt = self.db.data['topups/topup/payment_attempts/attempt']
        attempt.update(status='created', status_detail='awaiting_order_creation', mercado_pago_order_id=None)
        with patch.object(topups, 'create_order', side_effect=[provider.MercadoPagoOrdersNetworkError('private'), self.order]) as create:
            self.assertEqual(self.http.post('/topups/topup/payment-attempts/attempt/order').status_code, 503)
            self.assertEqual(self.http.post('/topups/topup/payment-attempts/attempt/order').status_code, 200)
        self.assertEqual([call.args[1] for call in create.call_args_list], ['attempt', 'attempt'])
    def test_missing_auth_denied(self):
        self.app.dependency_overrides.clear()
        self.assertEqual(self.http.post('/topups', json={'package_id': 'starter'}).status_code, 401)


class AdapterTests(unittest.TestCase):
    def setUp(self): sdk.reset_mock()
    def test_unexpected_sdk_error_is_safe_even_in_outer_tracebacks(self):
        import traceback
        sdk.order.return_value.get.side_effect = RuntimeError('SECRET_TOKEN_PRIVATE_PAYER')
        try:
            provider.get_order('ORD123')
        except provider.MercadoPagoOrdersNetworkError as error:
            self.assertNotIn('SECRET_TOKEN_PRIVATE_PAYER', ''.join(traceback.format_exception(error)))
        finally:
            sdk.order.return_value.get.side_effect = None

    def test_adapter_idempotency_and_safe_errors(self):
        sdk.order.return_value.create.return_value = {'status': 201, 'response': {'id': 'ORD123'}}
        self.assertEqual(provider.create_order({'total_amount': '129.90'}, 'attempt')['id'], 'ORD123')
        self.assertEqual(sdk.order.return_value.create.call_args.args[1].custom_headers, {'X-Idempotency-Key': 'attempt'})
        for status in [401, 403, 429, 500]:
            sdk.order.return_value.get.return_value = {'status': status, 'response': {'secret': 'private'}}
            with self.assertRaises(provider.MercadoPagoOrdersError) as caught: provider.get_order('ORD123')
            self.assertNotIn('private', str(caught.exception))
