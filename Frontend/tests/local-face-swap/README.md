# Local Face Swap integration fixture

Never deploy this fixture. It is outside the normal application entry point.
It uses the real FaceSwap component, API adapter, AuthProvider, Firestore
subscription, intent persistence, uploads and library services. Only the test
entry/configuration and external provider are substituted.

## Isolation

- Project is always `demo-xiaswap-finance-tests`.
- Auth: `127.0.0.1:9099`; Firestore: `127.0.0.1:8787`; Storage: `127.0.0.1:9299`.
- Backend: `127.0.0.1:8789`; frontend: `127.0.0.1:5179`.
- Vite does not read the normal `.env` and fixes VITE_API_URL to the test backend.
- Firebase configuration is replaced by a demo-only app connected to all emulators.
- CSP blocks external connections/images; Axios rejects a nonlocal API base URL.
- The backend refuses startup unless all emulator variables have exact loopback
  values. It uses anonymous credentials, installs Firebase/DeepSwap test modules
  before importing routes, and blocks nonlocal Python HTTP connections.
- No production backend, credentials, DeepSwap API or production balances are used.
- Test controls under `/__test/*` are deliberately loopback-only and MUST NOT ship.

## Run from the repository root

Use an already installed Firebase CLI; no dependency installation is required.
Start the three processes in separate terminals:

```sh
firebase emulators:start --only auth,firestore,storage --project demo-xiaswap-finance-tests --config Frontend/tests/local-face-swap/firebase.json
```

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8787 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 STORAGE_EMULATOR_HOST=http://127.0.0.1:9299 Backend/venv/bin/python -B Backend/tests/local_face_swap_server.py
```

```sh
cd Frontend
./node_modules/.bin/vite --config tests/local-face-swap/vite.config.mjs
```

Open `http://127.0.0.1:5179/` in a separate browser window. Select **Run isolated
integration checks**. The report covers success, failure, same-key duplication,
response loss injected in the Axios response handler, manual recovery, 409/422,
and a simulated provider timeout whose task ID is lost.

For actual component interaction: **Prepare UI fixture uploads**, then **Criar
Face Swap**. The simulator keeps the task RUNNING until **Complete simulated
task** is selected. Reload first to verify no automatic second generation; select
**Recuperar operação** and complete the simulated task.

## Important differences and limits

Storage Emulator download URLs use localhost, but the production backend only
accepts canonical Firebase addresses. `uploads.ts` wraps the real upload and
converts only the address representation. The backend test bucket reads real
emulator metadata and simulates version-bound signing. Canonical preview images
are intentionally blocked by CSP. Results use a local PNG and are saved using
the application's real Storage and library services against the emulators.

Test rules are separate, permissive authenticated demo rules; this does not
validate deployed production rules or private-key URL signing. The backend does
not implement real facial processing. It never imports the real provider module.
Each automated scenario creates a separate anonymous demo user before seeding
credits, avoiding resets of balances with another scenario's active reserves.

The multi-page reconciliation integration test assumes no unrelated pending
records in its demo database. Run that suite in a fresh emulator, separately
from this browser fixture. Historical transaction lock timeouts remain a distinct
risk even when a later run passes.

Stop all three processes when finished. Emulator state is disposable; no export
or deployment is required.
