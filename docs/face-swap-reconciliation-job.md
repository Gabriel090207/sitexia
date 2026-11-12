# Face Swap reconciliation job (prepared, not scheduled)

## Existing financial contract

`generations` holds reserved/charged/released funds and CREATED, SUBMITTING,
PROCESSING, SUCCEEDED, FAILED states. Reservations freeze cost and intent. Backend
submission grants and `face_swap_tasks` bind owner, taskId, generationId and attempt.
The existing reconciler selects only type=face-swap and creditStatus=reserved,
ordered by document ID, with a bounded limit and start_after cursor. It verifies
both links before calling the existing finalizer, which checks provider status
and revalidates evidence in the existing Firestore transaction. SUCCEEDED charges
once; FAILED releases once. Other states, missing tasks and errors never imply a
refund. Legacy upfront-debited tasks are not migrated/charged. SUBMITTING without a
trusted task ID requires separate administrative review; the job never resends.

No scheduler or deployment manifest was found in the repository. Published Render
configuration was not accessed, so an external schedule cannot be ruled out.

## Internal entry point

From a backend working directory, after authorization of its target environment:

```sh
python -m app.jobs.face_swap_reconcile --execute --page-size 50 --max-pages 10 --max-seconds 240
```

Without `--execute`, the command exits before Firebase/provider initialization.
There is no HTTP administrative route, client secret or public invocation surface.
Execution requires the existing service credentials and OS/service access.
This is NOT a dry run: --execute can finalize actual financial records in whichever
project those credentials target. Do not invoke it against production during tests.

Defaults inspect up to 500 records in a scan, sequentially. Page size is 1..100,
max pages 1..100 (at most 10,000 records), and duration 1..900 seconds. A supervisor
process kills the worker on its duration deadline, even if a synchronous Firestore
call stalls. It does not release funds on termination. A commit in flight can have
an unknown outcome; reexecution is safe because finalization is idempotent.
Provider calls retain their existing HTTP timeout and per-item failure handling.
An individual timeout/error is preserved and the existing service continues.

Each page logs only count and a technical 64-hex cursor; summaries contain only
whitelisted outcomes. No raw exception, UID, provider response or URL is logged by
the runner. Initialization errors are also generic. The reconciler/provider keep
using their existing sanitized application logging.

Exit codes: 0 = full scan without review/errors (PENDING/RUNNING may remain);
1 = initialization, query or malformed page failure; 2 = scan limit reached or
individual errors/manual-review outcomes; 124 = supervisor duration exceeded.
A full last page can require another empty page. Completed scans next start from
no cursor. For an incomplete scan, an authorized operator can pass
`--after-id <64-hex-next_cursor>` to continue the SAME scan. After a failed page use
its logged resume_after; restarting from the beginning is financially safe too.

There is no durable checkpoint store in this change. The Render cron filesystem is
ephemeral. If pending records exceed the configured scan budget, blindly restarting
from the first page can starve later pages. Do not activate a schedule until a full
scan fits observed limits; monitor incomplete outcomes and perform explicit
continuations. Larger workloads require separately scoped durable checkpointing.
Records inserted before the current cursor are picked up by the next full scan.

## Isolated manual verification (no provider calls)

Use existing venv, offline mocks and synthetic financial fixtures:

```sh
Backend/venv/bin/python -B -m unittest discover -s Backend/tests -p 'test_face_swap_reconcile_job.py' -v
Backend/venv/bin/python -B -m unittest discover -s Backend/tests -p 'test_face_swap_reconciliation.py' -v
Backend/venv/bin/python -B -m unittest discover -s Backend/tests
```

These tests run the real runner/reconciler/finalizers over mock Firestore commits,
replace provider fetches, and exercise two concurrent job scans, repeat finalization,
timeout/recovery, item failures and bounded paging. Supervisor timeout is tested
with a mocked subprocess; no real account, provider query or credit is used.
For real Firestore integration separately use the existing demo-only emulator suite
in Backend/tests/integration; do not run the CLI with local application credentials
as a substitute. No new emulator requirement or SDK version is introduced here.

## Future Render configuration — DO NOT create/activate now

Only after environment approval, index verification and controlled validation:

- Type: internal Cron Job; repo Gabriel090207/sitexia; explicitly approved release
  branch/commit; root directory Backend; existing Python runtime/venv requirements.
- Build: `pip install -r requirements.txt` (future build only; not executed here).
- Command: `python -m app.jobs.face_swap_reconcile --execute --page-size 50 --max-pages 10 --max-seconds 240`.
- Proposed schedule: `*/10 * * * *` (UTC), subject to measured queue/runtime and
  provider quota. No manifest was added to prevent accidental provisioning.
- Environment: Render's RENDER flag, FIREBASE_CREDENTIALS_JSON,
  FIREBASE_STORAGE_BUCKET, DEEPSWAP_BASE_URL, DEEPSWAP_ACCESS_KEY,
  DEEPSWAP_SECRET_KEY. The Firebase bootstrap currently initializes a bucket even
  though the job only needs Firestore. No signing permission is needed by this job.
  Supply secrets through the service environment; never CLI arguments or logs.
  Select/verify the exact Firebase project in the service-account JSON; use only an
  approved test account during controlled verification. Do not set emulator vars
  on a future production service. No Mercado Pago credentials are required.
- IAM: service identity with only required Firestore reads and transactional
  updates to the existing financial documents. Admin SDK uses IAM, not Rules.
- Verify (do not assume deployed) the generations query index for type ASC,
  creditStatus ASC, __name__ ASC if Firestore requires it. This job creates no index.
- Monitor exit status, charged/released counts, review/kept_error outcomes,
  incomplete scans and duration limits. Review unlinked SUBMITTING manually;
  never release an ambiguous reservation based on age alone.
- Disable future schedule to stop new runs. A terminated job leaves existing
  reservations and completed commits intact; do not roll balances back manually.

Render runs one instance per cron service; manual triggering cancels a current run.
This platform guarantee does not replace transaction idempotency (manual finalizers
or other services can still race). Cron services incur charges and cannot attach a
persistent disk. None was provisioned here.

Official reference: https://render.com/docs/cronjobs (schedule, environment,
single-run behavior, billing and lack of persistent disks).
