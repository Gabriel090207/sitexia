# Account deletion — safe delivery fallback

## Findings

`Profile.tsx` previously deleted `users/{uid}` from the client, then called Firebase
Auth `deleteUser`. A recent-login failure at the second step could leave an active
Auth account without its financial document. The prepared Firestore rules correctly
deny deletion of that document, so the previous UI would show a misleading request
to log in again even for a permanent permission denial.

There is no administrative deletion endpoint. `get_current_user` verifies ID tokens
but does not check revocation/disabled status or require recent `auth_time`.
`generation_credits._reserve` and the payment creation paths do not consult an
account-closing state. Checking for pending work followed by deleting Auth alone
would not exclude concurrent requests. Auth and Firestore are not one transaction.
A safe, recoverable implementation therefore needs coordinated lifecycle changes,
not a delete_user call added to a route.

## Implemented scope

The existing profile button now opens an explicit unavailable notice with only an
acknowledgement action. No Firestore mutation, Auth deletion, API request, sign-out,
refund, cancellation or financial change is initiated. Repeated clicks have no
side effects. No user is told that deletion succeeded or that reauthentication
would enable the unavailable operation. Password reset and profile reads remain.
This is a temporary safe fallback, not completed self-service account deletion.

## Records retained unchanged

No records are removed or anonymized in this step: users (including credits and
reservedCredits), generations and frozen/idempotency/submission evidence, topups
and payment_attempts, credit_transactions, subscriptions (root and user history),
face_swap_tasks/materials, library entries and Storage objects all remain intact.
Pending work is neither released nor cancelled. Reconciliation/recovery stays on
its existing path. No retention period or disposition of remaining credit is
invented; those requirements must be defined before destructive processing.

## Minimum work before enabling actual deletion

1. Define retained versus erased/anonymized data, handling of remaining balance,
   pending payments, unknown submissions and generations; do not infer refunds.
2. Introduce a durable backend-owned closing/completion record and a recoverable,
   idempotent administrative workflow. Determine the UID solely from verified Auth;
   require a recent authentication time, with provider-appropriate reauthentication.
3. Prevent new financial/generation/payment operations during closing using the
   same concurrency boundary as their writes. Coordinate client Rules, backend
   session invalidation, already-issued tokens and in-flight requests.
4. Resolve or explicitly hold pending reservations/tasks/payment attempts without
   deleting their evidence. Preserve webhook/credit idempotency after Auth removal.
5. Stage Auth disable/revoke/delete and profile anonymization with retry/recovery
   states for failures between systems; never delete the financial document first.
6. Report completion only after confirmed success, then clear the session and
   prevent further application actions by the deleted account. Exercise each
   intermediate failure and repeated request against emulators before enabling UI.

The UI does not prevent a user from independently invoking Firebase Auth's own
account-deletion API. Such an Auth-only deletion is not a complete application
closure; protected financial records remain. Handling that event is another input
the administrative lifecycle must address. No new deletion endpoint exists here,
so endpoint UID spoofing, recent-auth expiry and partial Admin deletion tests are
not claimed as implemented/passing. Existing emulator tests verify that clients
cannot delete/reset financial records. Actual deletion remains a delivery blocker
if self-service deletion is required for release.
