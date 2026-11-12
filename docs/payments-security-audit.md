# Mercado Pago audit — local validation only

No real payment/account/credential was accessed. No packages, Rules, cron,
prices, deployment settings or historical financial records were changed.

## Active contracts and evidence

Registered by Backend/app/main.py: routes/topups.py and
routes/mercado_pago_webhook.py, using services/mercado_pago_orders.py and config/mp.py.
The active flow is Orders API, not a Preferences redirect. The separate legacy
routes/subscription.py is not registered by this main.py; it was not altered.

Frontend api/topups.ts sends package_id, method and card token/identification to
backend; pages/Checkout/Checkout.tsx tokenizes through MP and polls backend status.
It does not write financial Firestore records. The success state waits for
credits_granted; redirects/query-string status never grant a balance.
config/packages.py freezes prices/credits into backend-created topups. Request
schemas forbid extra price/credit/user fields. Authenticated routes take uid from
verified Firebase claims and check ownership on topup and payment_attempt.

Each attempt has a backend-created Firestore ID used as X-Idempotency-Key when
creating its Order. Pix/card transactions exclusively claim creation, store the
Order/payment IDs and recover an existing attempt. A network retry uses the same
attempt key. It is not equivalent to creating another attempt. Changing card token
or payload on a retry can conflict with provider idempotency: sandbox must verify
that recovery behavior before rollout.

Webhook HMAC SHA256 uses lowercased alphanumeric data.id, x-request-id and ts in the
manifest and the backend MERCADO_PAGO_WEBHOOK_SECRET, with compare_digest. Missing
or invalid signature stops before provider access. ts is signed but no freshness
window is enforced. Replays do not duplicate credits; no arbitrary replay window
was imposed without an applicable retry policy.

The body is a notification, not financial evidence. get_order consults the SDK
with the server access token. The stored Order ID, external_reference/topup ID,
amount, topup currency, available response currency fields, payment ID when
already recorded, payment method and attempt/topup UID are checked. Account scope
comes from that access token plus the persisted Order link. There is no separate
configured collector/account-ID comparison; published receiving account, token
scope, application secret and test/live-mode alignment remain unverified.

Only processed/accredited normalizes to approved. Status reconciliation and credit
grant are separate transactions, so retry must recover the gap. Grant rechecks
approved/accredited and UID, then atomically updates user credits, creates the
single credit_transactions/{topup_id} marker and sets credits_granted. The marker
or flag prevents another grant. Fractional existing credits and reservedCredits
are preserved. SDK retry wrappers remain isolated per invocation.

## Confirmed corrections

- The validator ignored order.currency_id. It now checks that field as well as
  currency and payment.currency_id, rejecting any supplied conflicting currency.
  It does not invent a response field or assume every legacy response has one.
- Pix lacked the completed-topup check present in card creation. It now rejects
  an already credited/approved/completed topup before creating a provider Order,
  including pre-existing attempts. No package values or credits were changed.

## Outcomes and limitations

pending/processing/failed/cancelled/expired do not grant. Unknown states are ignored.
A refunded Order is recorded but no automatic balance subtraction/refund is
implemented. Chargeback is not mapped to a financial reversal. Previously granted
credits remain; reversal/consumed-credit policy and administrative handling are a
release prerequisite, not an invitation to invent a negative balance.

Multiple attempts can exist for one topup. Approval grants once per topup, not once
per paid attempt. More than one paid attempt is therefore an exception requiring
review, not extra credits. Also, late notifications from older attempts share the
aggregate topup status; terminal-state ordering can prevent a later valid attempt
from reaching approved. This needs a separately designed aggregate/attempt recovery
contract and regression coverage before claiming the multi-attempt lifecycle safe.
No historical status was migrated or financial architecture changed here.

Total_amount is compared with the frozen topup amount. The current implementation
does not independently validate all settlement/paid/tax fields or require a
currency field when the API omits it. Verify actual sandbox Orders schemas and
amount semantics before tightening those contracts. GET under server credentials
is not a substitute for verifying published account configuration.

If creation succeeded but persistence failed, the attempt may stay processing
without its Order ID; a webhook cannot locate the attempt yet. No safe automatic
recovery service exists for that gap. Unknown outcomes require provider-evidence
review with the same attempt key, not a fresh charge. Missing webhook delivery or
provider/Firestore outage can delay credits; frontend polling itself does not
reconcile provider state. Do not label such cases unpaid or refund automatically.

Application payment routes/adapters do not log payment bodies/tokens/signatures;
adapter error messages and chained errors are generic. Third-party SDK runtime
logging remains unverified because mercadopago is missing from the current venv,
although it is declared in requirements.txt. No installation or real API request
was performed. Production tracing/log settings were not inspected.

## Tests and reproduction

- 237 backend unit tests passed, including 15 new payment tests with mocked SDK,
  serialized rollback-capable Firestore fixtures, signatures, concurrent/repeated
  webhooks, mismatches, failures and retries.
- Auth/Firestore Emulator: 25 existing client-security tests passed using real
  synthetic Auth tokens; direct financial mutations remain denied.
- Three additional actual Firestore payment tests passed: concurrent/repeated
  grants, failure between approval and grant followed by retry, and currency/refund
  rejection. Provider Orders and signatures are synthetic. Seven plain emulator
  transaction-lock-timeout warnings occurred during execution and were recovered;
  this is not proof of absent contention/intermittency. No balance inconsistency
  was observed in assertions. The mocks do not replace this emulator validation.
- 292 frontend tests passed, including three payment adapter/checkout regressions.
- Python compileall, TypeScript/build and git diff --check passed. The build retains
  the known bundle-size warning.

Run existing unit suites normally. For the emulator payment suite, use the
firestore-rules README environment setup (demo-xiaswap-financial-rules; Auth9497,
Firestore9498) and append this command inside emulators:exec:

```sh
Backend/venv/bin/python -B Backend/tests/integration/payments_emulator.py
```

The script refuses any other project/host, uses AnonymousCredentials and loads only
stub SDK/config dependencies. It never imports production Firebase initialization.

## Publication decision

Not certified for real payments yet. Resolve the exception/reversal and recovery
procedures above; install the already-declared SDK in an authorized test build;
validate SDK compatibility, signed webhooks, receiving account, amounts, Pix/card
idempotency and test credentials in an explicitly approved sandbox. Verify the
published Firestore Rules match the prepared backend-only financial policy.
Do not use production as a substitute or activate deployment from this audit.

Official sources inspected:
- https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications
  (Orders notification signature and status/currency examples).
- https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-api/get-order/get
  (authenticated Order lookup; returned payment/status/amount fields).
