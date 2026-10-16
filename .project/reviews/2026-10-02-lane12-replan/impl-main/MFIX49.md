# MFIX49 — fresh Agent Sessions do not start

## Outcome

No defect was changed locally. All three observed failures are outside MFIX49's current-source ownership and were posted to `HANDOFF-OTHER-PROGRAMS.md` under `Lane 12 Main → <owner>` as the brief requires. The Claude failure is a stale loaded server/schema snapshot, the Codex attempt never reaches daemon spawn admission, and the Artifact 500 is an expired shared serializable read transaction. No credential secret was read or printed, and no stack lifecycle command was run.

## Evidence and causes

### Claude / `spawn_failed`

- **Observed:** On nl3, daemon log `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-l12-main/cli/logs/2026-10-16-11-11-30-pid-1089083-daemon.log` records `runner_bootstrap` completing at 11:58:29 local. `POST /v1/sessions` then repeatedly returns `shared_qa_schema_mismatch`; `session.spawnNew` ends after 17,798 ms with no Session or runner.
- **Observed:** The matching `logs/server.log` records Prisma `P2022` in `resolveExistingLayout1SessionInTx` / `createOrRejoinLayout1SessionByTagInTx` and says the QA snapshot cannot query the current shared dev schema and must be reloaded.
- **Derived cause/phase:** failure is server Session materialization after daemon bootstrap and before agent credential validation/provider launch. The reportedly revoked `ai1` credential is not reached, so it is not the cause of this attempt and no credential-error UI fix is supported by this evidence.
- **Fix:** none in MFIX49. Routed to the stack/runtime snapshot owner; a local error remap would conceal the operational schema defect.

### Codex / indefinite `Starting session…`

- **Observed:** For the 10:02:31Z submission, there are zero `session.spawnNew` entries between 12:02 and 12:08 local; the only such entry in the full daemon log is Claude's earlier request. No Session id or runner exists.
- **Observed:** The server's `provider-account-usage` `TransactionConflictExhaustedError` events occurred at 09:14Z, not during this attempt.
- **Derived phase:** the attempt stalls before daemon spawn admission/issuance, in the UI/Action front door or operation settlement corridor. Provider launch is not reached.
- **Unknown cause:** the available daemon/server evidence has no operation id or contemporaneous failure, so choosing approval deferral, connected-service preflight, or Account contention would be assumption rather than diagnosis.
- **Fix:** none in MFIX49. Routed to the SESSIONOPEN/PLUGVIS owner, whose current moving source already changes this Action/front-door corridor; the handoff requests persisted-operation recovery and a loaded replay.

### `/new` Artifact HTTP 500

- **Observed:** Between 09:57Z and 10:03Z, `logs/server.log` repeatedly reports that the 15,000 ms Prisma interactive transaction is expired/not found during Artifact, Account, or PublicSessionShare queries. `artifactsRoutes.ts` maps the exception from `readArtifactBatchForCaller` to HTTP 500 `artifact_content_unavailable`.
- **Derived cause:** `readArtifactBatchForCaller` loops requested Artifact ids inside one `readSnapshotWithCurrentAdmission` serializable capture; the shared transaction expires before the batch completes. This belongs to the Account/storage read-contention corridor named by the brief.
- **Derived non-relation:** `154a5fec39` changes only `apps/cli/src/api/artifacts/accountArtifactStore.ts` and its GET `/v1/artifacts` header path (`createHeaderReader` / `readHeader`). The failing browser request is POST `/v1/artifacts/read` through the server batch-detail owner, so DF83b did not cause it.
- **Fix:** none in MFIX49. Routed to the Account/storage Artifact-read owner; no speculative timeout increase, retry, or consumer workaround was added.

## Validation, commit, and reload

- RED/GREEN: not run; no production behavior was changed, and the brief requires stopping after routing defects in other program corridors.
- Diagnostics: read-only nl3 daemon/server log inspection through the canonical dev-target transport; focused source/commit inspection through `hstack-exec`/Git. No stack restart/stop/reload, database mutation, broad test, or secret access.
- Commit: this lane's private-index commit, subject `docs(review): report MFIX49 session launch diagnosis`, with the required Claude Opus 5.5 co-author trailer.
- Reload: MFIX49's report/board changes need none. Operational recovery for Claude requires Main/the stack owner to reload a schema-compatible server snapshot; Codex and Artifact need owner fixes loaded before replay. This lane was prohibited from performing that reload.

## Residual risk

Codex's exact pre-daemon subphase remains unobservable without its Action operation id/state; the handoff names that missing evidence rather than assigning a speculative cause. Claude, Codex, and `/new` remain unverified end to end until their owners repair/load the relevant corridors and Main replays them.

STATUS: BLOCKED
