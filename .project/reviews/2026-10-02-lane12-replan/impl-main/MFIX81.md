# MFIX81 — fresh Session never leaves `Starting session...`

## Outcome

The retained C30 evidence localizes the stop to the UI/account Action corridor before the daemon: the click occurred at approximately `2026-10-18T13:25Z`; Codex connected-account materialization completed at daemon-local `15:25:47.031` (`13:25:47.031Z`), but the daemon log contains no `session.spawn_new`, spawn-preparation, Session create, runner launch, or webhook line for the entire `13:24–13:49Z` window. Canonical `session.list` contained no new matching Session. Browser console/action diagnostics were lost with C30's deleted browser profile, so the retained logs cannot distinguish UI Action custody/admission from the server-carried machine RPC.

The mandated single replay did not reproduce the indefinite wait. It used ChatGPT · Leeroy, GPT-6-Luna Low, Machine `58f6e63a-cd69-4302-83f1-325d10da7ec3`, and `~/mqa2-c14-clone`; no reset credit was used and the development key entered only through stdin. One click occurred at `2026-10-18T14:00:30.512Z`. Session `cmvdw8d9100agmcfuxs65u5re` was created at `14:01:00.948Z`, appeared in the daemon at local `16:01:01.288`, reached the runner webhook at `16:01:34.286`, and fully spawned at `16:01:34.417`. I stopped it with canonical `session.stop`; final state was `active:false`. The replay produced no stuck draft to delete. The QA browser was terminated without restarting or reloading the stack.

## Trace and component

- UI owner: `apps/ui/sources/components/sessions/new/hooks/useCreateNewSession.ts` enters creating state, validates connected-account defaults, acquires Action custody, and calls the canonical `session.spawn_new` Action path.
- Action owner: `apps/ui/sources/sync/ops/actions/sessionSpawnNewAction.ts` and `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts` own custody/admission and `SESSION_SPAWN_NEW` dispatch. These files have substantial concurrent uncommitted edits, including reconciliation and transport diagnostics, so the brief's collision rule forbids an MFIX81 fix in that hunk.
- Daemon/runtime owner: replay operation `7512285f-e863-4662-b344-f21bca1667bb` entered at daemon-local `16:00:47.719`; `session_commit` consumed 14,254 ms, connected services 12,723 ms, and runner webhook 19,574 ms (46,698 ms total). Evidence: nl3 daemon log lines 85377–85841 in `2026-10-18-12-18-30-pid-2830516-daemon.log`.
- Browser-side `navigator.locks.query()` at `14:01:09Z` showed no held or pending Web Locks, excluding the spawn-attempt nonce lock for the replay. No browser error or unhandled rejection was observed.

## Database contention

The C30 server conflict was an independent `POST /v1/plugins/availability/collection-writers/claim` failure at `2026-10-18T13:35:40.335Z`: PostgreSQL `40001`, nine attempts, HTTP 500, code `database_transaction_conflict_exhausted`. It correlates with shared-database distress but is not the Session route.

The replay overlapped two `storage-tx` conflict-exhausted events at `14:00:30.748Z` and `14:01:01.825Z`, each after nine attempts. The retained warning records `transactionClass:"unspecified"` and does not record a route, while the Session request nevertheless succeeded. Therefore the exact Session transaction cannot honestly be attributed to either warning. The canonical server implementation in `apps/server/sources/storage/inTx.ts` retries a bounded nine times and throws typed `database_transaction_conflict_exhausted`; it is not an indefinite retry loop. HTTP/socket error owners already map that code to a typed failure. C30 supplied neither a typed failure nor a daemon arrival, so its observable defect remains the pre-daemon Action request failing to settle or surface an error.

## Fix and handoff

No production source was changed. A safe owner-level correction requires the active Action-admission program to preserve phase evidence from custody acquisition through server-scoped machine RPC and to settle the draft with the existing typed transport/database failure when dispatch fails. It must not add a second timeout or retry owner. Re-run the exact C30 recipe after those concurrent edits settle; the deciding evidence is whether the operation remains in UI custody/admission, receives a typed server error, or reaches daemon spawn preparation.

## Validation and reload

- Live replay: completed and stopped as described above; no foreign Session or database row was mutated.
- RED/GREEN and adjacent tests: not run because no source behavior changed and the canonical hunk is concurrently owned.
- Reload need: none; server, daemon, and UI were not restarted or reloaded.
- Residual risk: the original C30 causal sub-step is not recoverable from retained logs, and the successful replay does not disprove an intermittent pre-daemon settlement defect.

STATUS: BLOCKED
