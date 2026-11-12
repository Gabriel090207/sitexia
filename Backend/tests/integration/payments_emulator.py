"""Demo-only payment transactions using real Firestore and mocked provider Orders."""
import os
from pathlib import Path
import sys
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from unittest.mock import patch
from uuid import uuid4

PROJECT = 'demo-xiaswap-financial-rules'
if os.getenv('FIRESTORE_EMULATOR_HOST') != '127.0.0.1:9498' or os.getenv('GCLOUD_PROJECT') != PROJECT:
    raise RuntimeError('Requires dedicated demo Firestore Emulator')
sys.path.insert(0, str(Path(__file__).parents[1]))
import test_payments_audit as fixtures
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from fastapi import FastAPI
from fastapi.testclient import TestClient

db = firestore.Client(project=PROJECT, credentials=AnonymousCredentials())
with patch.dict(sys.modules, {'app.services.firebase': types.SimpleNamespace(db=db),
                             'app.services.mercado_pago_orders': fixtures.provider}):
    webhook = fixtures.load('emulated_payments_webhook', 'app/routes/mercado_pago_webhook.py')


class PaymentEmulatorTests(unittest.TestCase):
    def setUp(self):
        self.uid = 'synthetic-' + uuid4().hex
        self.topup_id = 'synthetic-' + uuid4().hex
        self.user = db.collection('users').document(self.uid)
        self.topup = db.collection('topups').document(self.topup_id)
        self.attempt = self.topup.collection('payment_attempts').document('attempt')
        self.ledger = db.collection('credit_transactions').document(self.topup_id)
        self.user.set({'credits': 1.5, 'reservedCredits': 0.5})
        self.topup.set({'uid': self.uid, 'amount': 129.90, 'currency': 'BRL', 'credits': 12,
                       'status': 'payment_pending', 'credits_granted': False})
        self.attempt.set({'uid': self.uid, 'topup_id': self.topup_id, 'payment_method': 'pix',
                          'status': 'payment_pending', 'mercado_pago_order_id': 'ORD123', 'mercado_pago_payment_id': 'PAY123'})
        self.order = {'id': 'ORD123', 'external_reference': self.topup_id, 'total_amount': '129.90',
                      'currency_id': 'BRL', 'status': 'processed', 'status_detail': 'accredited',
                      'transactions': {'payments': [{'id': 'PAY123', 'payment_method': {'id': 'pix', 'type': 'bank_transfer'}}]}}
        app = FastAPI(); app.include_router(webhook.router)
        self.http = TestClient(app, raise_server_exceptions=False)
        p = patch.object(webhook, 'get_order', side_effect=lambda _: deepcopy(self.order)); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'MERCADO_PAGO_WEBHOOK_SECRET': 'synthetic-webhook-secret'}); p.start(); self.addCleanup(p.stop)
    def tearDown(self):
        for ref in [self.attempt, self.topup, self.ledger, self.user]: ref.delete()
    notify = fixtures.PaymentTests.notify
    def test_real_concurrent_webhooks_and_repeat_credit_exactly_once(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.notify().status_code, range(2)))
        self.assertEqual(results, [200, 200])
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.user.get().to_dict(), {'credits': 13.5, 'reservedCredits': 0.5})
        self.assertTrue(self.topup.get().to_dict()['credits_granted'])
        self.assertEqual(self.ledger.get().to_dict()['amount'], 12)
    def test_real_failure_between_status_and_grant_is_recoverable(self):
        with patch.object(webhook, 'grant_topup_credits_once', side_effect=RuntimeError('synthetic')):
            self.assertEqual(self.notify().status_code, 500)
        self.assertEqual(self.user.get().to_dict()['credits'], 1.5)
        self.assertFalse(self.ledger.get().exists)
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.user.get().to_dict()['credits'], 13.5)
    def test_real_currency_divergence_and_refund_do_not_grant(self):
        self.order['currency_id'] = 'ARS'
        self.assertEqual(self.notify().status_code, 409)
        self.assertFalse(self.ledger.get().exists)
        self.order.update(currency_id='BRL', status='refunded', status_detail='refunded')
        self.assertEqual(self.notify().status_code, 200)
        self.assertEqual(self.user.get().to_dict()['credits'], 1.5)


if __name__ == '__main__':
    try: unittest.main(verbosity=2)
    finally: db.close()
