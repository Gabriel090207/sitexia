# Local validation results — 2026-11-09 (America/Sao_Paulo)

No deployment, real provider operation, production balance or published
configuration was used. Auth, Firestore and Storage were all emulated.

## Integrated browser checks

Executed in a separate Chrome incognito window, on 127.0.0.1:5179, against the
loopback test app on 127.0.0.1:8789. Real application API adapter, intent helpers,
AuthProvider, Firebase SDK uploads/subscriptions, result persistence and library
service were used. Provider processing and Storage signing were simulated.

- PASS: original and replacement uploads reached Storage Emulator; material,
  detection response, reserve and task linkage used the real route contracts.
- PASS: credit balance 10 with reservedCredits 0.1 displayed as 9.90 available.
- PASS: repeated SUCCEEDED status/result queries charged 0.1 exactly once.
- PASS: result PNG downloaded locally, uploaded to Storage Emulator and recorded
  by the real library service in Firestore Emulator.
- PASS: repeated same-key creation recovered the task without another provider task.
- PASS: FAILED released the reservation once, preserving credits 10; UI showed 10.00.
- PASS: Axios response-loss injection after a successful backend commit preserved
  the original key and IDs; no automatic POST occurred. Explicit recovery returned
  the existing task with no additional creation. This was simulated response loss,
  not a physical TCP disconnection.
- PASS: actual backend HTTP 409/422 matched frontend error handling.
- PASS: simulated provider timeout after creation, with lost taskId, preserved the
  reservation; explicit recovery returned pending 409 without another provider call.

## Actual component reload and manual recovery

Using the real FaceSwap component, fixture files were selected, then the normal
Create button was clicked. The simulator held the task RUNNING. The page was
actually reloaded, and the UI offered Recover operation while normal creation
remained disabled without newly selected files.

Before reload: materialCreates=5, taskCreates=5, taskPosts=10, credits=10,
reservedCredits=0.1. After reload and manual recovery, creation counters remained
unchanged. Completing the simulated task produced a visible result. Final state:
credits=9.9, reservedCredits=0, one charged/SUCCEEDED operation and one library
record for that demo user. No extra upload/material/task creation was needed for
recovery.

## Other verification

- 86 frontend tests passed.
- Normal frontend TypeScript/build passed; existing >500 kB bundle warning remained.
- Isolated fixture TypeScript check passed.
- 135 offline backend tests passed.
- Separate emulator concurrency selection: 6 passed, 1 error in
  test_concurrent_idempotency_key_reserves_once, with transaction lock timeout
  after five SDK attempts. This is not a fully passing contention validation.
- git diff --check passed.

No application source/configuration change was necessary in this step. Test
fixtures alone were added. Existing image generation files were not changed.

## Remaining boundaries

Production Storage rules, real signed-URL credentials, provider downloads,
provider output CORS and real processing were not validated. The canonical
Firebase preview URL adapter exists only for emulator interoperability; preview
requests to external origins are blocked by CSP. Test controls/rules must never
be deployed. Historical and current emulator contention failures remain open.
