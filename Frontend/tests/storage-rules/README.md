# Storage Rules — isolated emulator tests

Run from the repository root using existing Firebase CLI, Java 21+, Firebase SDK and
`@firebase/rules-unit-testing` tooling. No packages are installed by this suite.
If the test dependencies live outside the frontend, set
`STORAGE_RULES_TEST_MODULE_ROOT` to their package directory.

```sh
rules_test_dir=$(mktemp -d)
cp storage.rules Frontend/tests/storage-rules/firebase.json "$rules_test_dir/"
firebase emulators:exec --project demo-xiaswap-private-rules --only storage \
  --config "$rules_test_dir/firebase.json" \
  "node --test Frontend/tests/storage-rules/privateStorage.emulator.mjs"
```

The temporary copy is necessary because the CLI rejects rules outside the directory
containing its config. Tests also load the repository's actual rules. The suite
refuses to run unless the demo project ID and loopback Storage port match exactly.
The emulator is stopped by `emulators:exec`. Only synthetic bytes are created;
privileged seeding/clearing happens inside the emulator test environment.

Coverage includes owner uploads/reads, anonymous/cross-account denials, immutable
UUID inputs, nested/legacy objects, denied input listing, existing result CRUD/list
permissions, and default-deny namespaces. `resource == null` explicitly prevents
replacing existing inputs, including when the emulator evaluates an upload through
its create permission. These tests assert the denial rather than accepting it as
an emulator limitation.

No new MIME/size restrictions are introduced: inputs already have backend checks,
while the full set of final-result contracts needs review before adding Rules
limits. Existing result update/delete/list permissions remain owner-only.

Passing these tests does not validate real V4 signatures, IAM, ACLs, CORS, browser
playback or revocation of existing Firebase download tokens. Objects outside an
owner namespace have no client access under these rules. Coordinate publication
with current private consumers and audit legacy access before production rollout.
