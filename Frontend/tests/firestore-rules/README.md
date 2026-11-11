# Financial Firestore Rules audit and isolated tests

`firestore.rules` at the repository root is the intended application rules file;
root `firebase.json` now points to it. Before this step, only the deliberately
permissive local Face Swap fixture was versioned. That fixture is not a deployment
policy and remains unchanged. Published rules were not accessed and are unknown.

## Real contracts

- `users/{uid}`: client reads its own profile, `credits`, `reservedCredits`, plan.
  Signup currently writes uid/email/displayName/photoURL/free plan/zero credits and
  serverTimestamp. Permit exactly this initial bootstrap; subsequent writes can
  change only email/displayName/photoURL. No user listing or document deletion.
- `users/{uid}/swaps/{itemId}`: client image/video library entries and ordered
  createdAt queries; taskId equality query with limit(5) for recovery. Owner-only
  read/create/update/delete; known library fields only, including legacy no-type
  entries. Library references are not trusted financial or object ownership proof.
- `generations/{id}`: reservations, frozen costs, submission grants, idempotency,
  task binding and finalization/reconciliation. Backend-only, including reads.
- `face_swap_tasks/{id}`, `face_swap_materials/{id}`: authoritative task/material
  ownership, not editable/readable directly by clients.
- `topups/{id}`, `topups/{id}/payment_attempts/{id}` and
  `credit_transactions/{id}`: payment state, attempts and credit grants. Backend-only.
- `subscriptions/{id}`, `users/{uid}/subscriptions/{id}`: subscription/financial
  history paths in legacy subscription code, backend-only. The frontend gets
  current payment status through authenticated HTTP APIs, not direct Firestore.
- Unknown paths and deeper subcollections are denied; there is no recursive owner
  write permission. Admin SDK authorization is IAM, independent of client Rules.

## Compatibility and publication blockers

`Profile.tsx` currently deletes `users/{uid}` from the client before deleting the
Auth account. This is intentionally denied: it would erase balance/reservations
and permit recreation. Deliver coordinated administrative deletion separately;
no frontend or backend implementation changed in this step.

The legacy video task lookup in `video_generation.py` falls back to a
client-written library taskId when no financial generation is found. These rules
must preserve taskId for video extension/recovery and cannot turn that field into
trusted proof. Review that legacy authorization separately; it is not a financial
write permission and was not changed here.

No production rules/indexes/IAM were read or published. Validate actual published
rules, signup/login, account deletion handling, payment APIs, and any external
clients before coordinated rollout. This audit does not certify production payments.

## Run (existing tooling only, no dependency installation)

Use Firebase CLI, Java 21+, `firebase`, `@firebase/rules-unit-testing` and the backend
venv. If tooling lives elsewhere set FIRESTORE_RULES_TEST_MODULE_ROOT to its package
root. Run from the repository root:

```sh
financial_rules_test_dir=$(mktemp -d)
cp firestore.rules Frontend/tests/firestore-rules/firebase.json "$financial_rules_test_dir/"
firebase emulators:exec --project demo-xiaswap-financial-rules --only auth,firestore \
  --config "$financial_rules_test_dir/firebase.json" \
  "node --test Frontend/tests/firestore-rules/financialRules.emulator.mjs && Backend/venv/bin/python -B Backend/tests/integration/firestore_rules_admin.py"
Backend/venv/bin/python -B -m unittest discover -s Backend/tests
```

Auth runs on 127.0.0.1:9497 and Firestore on 127.0.0.1:9498. Tests refuse any other
project/host. Actual SDK calls use synthetic Auth accounts and data. Privileged
fixtures and the separate Admin SDK proof use only the emulator. No app Firebase
configuration, real credentials, payment provider or DeepSwap calls are loaded.
The emulator compiles/evaluates the actual repository rules as syntax validation.
