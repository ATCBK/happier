# FX91b — original CLI copy admission and counted memory workload

Source corrections are implemented and focused validation passes. **Acceptance remains blocked:** the installed CLI still returns `forbidden`, its loaded guard's exact failed conjunct was not observed, the public CLI typecheck fails in an unrelated UI/SDK theme seam, and three foreign MCP neighbours remain failed and handed off. No loaded-runtime copy repair or elimination of live idle traffic is claimed.

## Deliverables

1. **Original CLI admission correction.** `apps/cli/src/api/externalActionExecutionAuthorization.ts#requiresOriginalAccountMachineActionProof` now includes `projects.worker.copy.inspect`. The existing CLI dispatcher therefore uses the Home-signed original requester path even for its own locally published daemon. The existing requester admission owner supplies current personal Machine custody. The preview guard, actor=custodian requirement, manage role, Home/Machine equality, credential currentness, target ownership and strict output schemas are unchanged. No local grant reconstruction or alternate inspection transport was added.
2. **Composed original-CLI regression.** `apps/cli/src/daemon/externalActions/executeExternalAction.filesystemApprovals.test.ts` adds `preserves personal copy inspection through the original standalone CLI admission`. Its existing testkit now publishes the fixture's actual daemon control port/token in its temporary Home, permits real loopback control HTTP, and serves the copy-inspection authorization routes at the Home HTTP boundary. It exercises the real credentialed CLI factory, discovery, local control server, installed executor, RPC registration and Sync owner. Home HTTP, Machine sockets and native Sync remain the existing system boundaries. The fixture adopts an existing directory: the correct final result is Sync's `workspace_copy_not_owned`, not fabricated deletion custody. Removing the proof binding reproduces the original `forbidden` RED. The final case also derives portable Home identity through the ordinary feature reader rather than injecting it into the CLI factory.
3. **Canonical prompt-demand correction.** `apps/cli/src/settings/prompts/hydratePromptLibraryCatalog.ts` uses the existing loader's `maintainSource: false` option for explicit fresh destination demand, in both incumbent-Account and captured-operation paths. Explicit catalog refresh and Account-change maintenance retain source cleanup and fresh exact-history witnesses. No observation cache, timer, TTL, new protocol or competing history owner was introduced. FX91's identity-reader and MCP-dispatch corrections remain intact.
4. **Three memory fixture repairs.** `apps/cli/src/daemon/memory/memoryWorker.test.ts` supplies the missing POST `/v1/account/project-rows/list` boundary with an authoritative complete empty census. The real Project association owner remains active. All original 5-entry/2-document, scoped fact, search, revision, retirement, detach, revocation and disabled-memory assertions remain. The earlier hypothesis that the stats assertion merely preceded consumer demand was refuted: `ensureUpToDate('s1')` already requests document admission. The final correction is the missing HTTP fixture, not a production workaround or changed expectation.
5. **Foreign-owner handoff.** The existing `../HANDOFF-OTHER-PROGRAMS.md` has the bounded “Lane 12 FX91b” entry covering the three MCP neighbours and the public compiler blocker. No foreign policy, normalization or assertion hunk was changed.

## Live, read-only evidence

All installed-CLI probes ran locally through the exact existing `agent-qa-l12-b` configuration, as authorized by this brief. The CLI loaded its own credential; no credential file was read by the probes. Outputs were reduced to identifiers, custody/access facts, schema keys, codes and booleans. No credential, key, decrypted content, raw request/response body or user plaintext was emitted or retained.

Observed:

- At **21:32:31.566Z**, `account.profile.get`, with the required explicit Home profile selector, returns Account `5e3a0581-6f3d-4e73-bf40-383db0be6c3e`.
- The fresh `machines.list` result at **21:29:58.638Z** gives Machine `d06f323d-88fa-4491-bc40-aebac4734bd6` that same custodian Account, role `manage`, access `ready`, active `true`. Thus a distinct CLI actor is not the explanation established by these reads. The initial profile call without `--server-id` returned `invalid_arguments`; it supplied no actor fact and was corrected.
- The installed stdio MCP read at **21:55:07.222–21:55:23.288Z** successfully invokes `workspace.sync.relationships.list`. The exact `relationship_35795478b17239948941a5c42c6938da442a225b8ccdf632645665592d5b0ca8` remains enabled, watching, controller d06f…, alpha `437c83c0-291a-4f4c-b683-90a9ac2a3c45`, beta `6d1445c0-3e1f-4f1e-94eb-4bc1e063b2c3`, updatedAtMs `1792163899945`, with matching `worker_clean_copy` source/target provenance. The transport was closed. The ordinary CLI Action attempt returned `target_required`; it is not substituted for this successful fresh read.
- Exact inspection uses the unchanged `qa-shots/LV13b/inspect-request.json` input. It returns exit 1/`forbidden` at **21:30:51.133Z**, and the final replay at **22:18:34.093Z** still returns exit 1/`forbidden` (handle 89423). Retained LV13b UI success at 20:09:10.503Z is historical evidence, not a fresh FX91b browser replay.

The invocation is the existing command owner:

```sh
node apps/stack/scripts/repo_local.mjs stack happier agent-qa-l12-b --runtime=source -- actions invoke projects.worker.copy.inspect --machine-id d06f323d-88fa-4491-bc40-aebac4734bd6 --input-json '<exact LV13b input>' --json
```

**Derived source cause:** the original own-daemon control path lacks signed requester custody; `resolveRequesterIngress` has no requester to project, so `invokeLocalMachineAction` reaches the personal guard without Machine admission. FX90's requester-role reconstruction cannot repair a request that never enters that requester path. The new real-control regression reproduces this distinction and becomes GREEN through the existing proof owner. This establishes a current-source defect, not a measurement of the retained loaded daemon's exact failed conjunct. Temporary own-process network/preload probes supplied no decisive live predicate telemetry and were removed; no production logging was added.

**[blocked] Loaded predicate/replay:** the integration owner must load the coherent CLI/daemon source and repeat the exact inspection, observing the current admission predicate if it still refuses. FX91b did not rebuild/reload the QA stack or inspect private runtime logs. Actor/custodian/role and the fresh relationship alone do not prove current credential or verifier lifetime.

## Counted Machine → memory evidence

The composed regression now reaches `idle_admission_workload`; the prior `foreign_profile_refusal` timeout did not recur. No timeout or resource budget was increased.

Observed RED: twelve repeated admissions produce **12** recurring encryption/currentness reads instead of zero. A temporary stack-only HTTP probe attributes all twelve to `promptLibraryStore.ts#normalizeHistory` → `normalizeAccountSettingsHistoryClientV1` → the fresh exact-currentness reader during optional retained-source cleanup. They were not extra mode reads bypassing the existing observation. Replacing exact witnesses with cached identity would have weakened the contract and was not done.

Observed GREEN: after the prompt-demand correction, the same real `ApiMachineClient` → authenticated user Socket.IO observation → prompt admission → SQLite workload performs twelve admissions over **600,000 simulated milliseconds**, with **zero recurring identity HTTP reads**. It also refuses disconnected admission, recovers after reconnect and refuses a pushed Account-mode change. The complete document-admission and prompt-hydration owner files pass 28 tests. This is composed source evidence, not a real ten-minute loaded idle capture.

## Six neighbour adjudications

| Neighbour | Attribution and disposition |
| --- | --- |
| MCP disconnected `workspace.tabs.list` | Foreign current uncommitted `packages/protocol/src/actions/clientDispatchV1.ts#clientActionUnavailable` Workspace-family branch changes absence to `unsupported_action`. HEAD lacks that branch. The composed relay expectation remains untouched; handed off. |
| MCP `session_board_get` inventory | Committed foreign Action-policy/test drift: `50e01306e5` changed the canonical feature mapping to gate only `session.board.layout.update`. The old MCP read-inventory expectation remains untouched; handed off. |
| MCP mocked Account `serverIdentityId` | Existing fixture `stable-home-identity` violates the canonical `srv_…` capability grammar and is normalized away. The source identity projection predates FX91 (`a7a76a8257` history). No normalizer weakening or internal mock addition; handed off. |
| Memory deep/deep | Missing real Project-row HTTP boundary; fixture repaired, original assertions GREEN. |
| Memory deep/hints | Same boundary defect; fixture repaired, original assertions GREEN. |
| Memory hints/hints | Same boundary defect; fixture repaired, original assertions GREEN. |

Read-only `git diff HEAD`, scoped log/history and current code were used for attribution; no clean tree was manufactured. The committed on-demand inventory change `6e56e0eda8` was inspected and preserved. The final fixture does not restore background document scans.

## Executed validation

The brief explicitly authorizes remote computation/workspace transfer under the standing **2026-10-10** grant. Every source test/compiler invocation used `./apps/stack/bin/hstack-exec`, its synchronization barrier and a continuously moving canonical mirror. No `--local`, direct implementation script, controller compiler escape, Stack lifecycle or Git mutation was used. nl3 executes from `/home/happier/happier-dev`; the earlier linux1 diagnostic used its configured canonical mirror.

| Check / handle | Terminal result |
| --- | --- |
| Initial four-file neighbour/workload batch, nl3 **86455** | Exit 1; **43 passed / 7 failed**. Reproduces all six requested neighbours plus the counted 12-read workload failure. |
| Workload stack diagnostic, nl3 **84318** | Exit 1; 1 failed / 14 filtered. Confirms twelve exact-history cleanup callers. Temporary stack instrumentation removed. |
| Document + prompt owner GREEN, nl3 **64217** | Exit 0; **28 passed**, including zero recurring reads and failure/recovery controls. 95.32s runner duration. |
| First original-CLI attempt, nl3 **44520** | Exit 1/`outcome_unknown` caused by incomplete Home-boundary modelling. Not valid regression RED; superseded by real local-control composition. |
| Correct original-CLI RED, nl3 **55596** | Exit 1; **forbidden** instead of the direct admitted Sync ownership result. 1 failed / 118 filtered. |
| Original CLI + installed UI/CLI requester GREEN, nl3 **89505** | Exit 0; **3 passed / 116 filtered**. Includes implicit Home-identity discovery. 61.77s. |
| Intermediate memory diagnostics, linux1 **67997**, nl3 **29338** | Exit 1; 3 failures each. They expose pending admission at `prompt_inputs`; no success inferred from moving the stats assertion. Temporary ordering/diagnostic changes were removed. |
| Final full memory + three worker composition files, nl3 **48021** | Exit 0; **33 passed**, including all three document-index permutations and FX84/FX91 CLI/session-MCP/standalone-MCP regressions. 116.06s. |
| Authority/currentness corridor, nl3 **48529** | Exit 0; **117 passed / 1 skipped** across four files. Exercises owned-copy success, foreign/stale refusal, ordinary paired-terminal routing, Account/Home isolation, signed transport and exact witnesses. Existing skip is not counted as executed. 91.36s. |
| Public CLI typecheck, nl3 **64607** | **Exit 2**; `/tmp/fx91b-cli-typecheck.log` on controller. UI prerequisite `pluginUiThemeProjection.ts:49` emits TS2353: `dataAccent` is absent from the SDK theme token union. No CLI-partition/package clearance claimed. |
| Scoped whitespace | `git diff --check` exits 0 for the changed source/test corridor. |

Commands for the successful source boundaries:

```sh
./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn vitest run src/daemon/memory/syncMemoryDocuments.test.ts src/settings/prompts/hydratePromptLibraryCatalog.test.ts --maxWorkers=1 --reporter=dot
./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn vitest run src/daemon/externalActions/executeExternalAction.filesystemApprovals.test.ts -t 'personal.*copy|original standalone CLI admission' --maxWorkers=1 --reporter=dot
./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn vitest run src/daemon/memory/memoryWorker.test.ts src/mcp/createExternalMcpServer.projectWorkers.test.ts src/mcp/createHappierMcpServer.projectWorkers.test.ts src/session/actions/createCliActionDeps.projectWorkers.test.ts --maxWorkers=1 --reporter=dot
./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn vitest run src/workspaces/sync/workspaceSyncTargetAuthority.test.ts src/session/actions/createCliActionExecutorFromCredentials.sessionCreationAdmission.test.ts src/daemon/sessionEncryption/requesterAccountCurrentness.socket.test.ts src/api/client/accountKvJsonTransport.test.ts --maxWorkers=1 --reporter=dot
./apps/stack/bin/hstack-exec --target=nl3 -- yarn workspace @happier-dev/cli typecheck
```

Remote dependency refresh and publication leases caused substantial waits. The first Windows copy-regression launcher **61855** never collected tests and was cancelled through only its confirmed process group, terminal exit 130; the real RED was then run on nl3. No foreign lock/process was modified. All lane-launched operations are terminal. All installed CLI children and the MCP transport closed. Temporary own-process probes and test diagnostics were removed; no secret-bearing evidence file was created.

## Self-check and residual risk

The author self-attack refuted the distinct-actor explanation and the memory test-ordering hypothesis, rejected reusing identity observations for exact history witnesses, and replaced the first copy fixture with actual local-control wiring. The source fix uses the existing original-proof owner rather than granting Machine admission from local presence or a method's minimum role. The shared prompt loader remains the sole destination/transfer owner; its existing source/history maintenance path is intentionally retained. No competing authorization, identity cache, transfer owner or persisted format was introduced. Neighbouring authority and lifetime tests ran.

Visible/design changes: **none**. No rendered UI, styles, controls or copy changed. No public protocol, persistence, feature policy or SDK ABI changed; these restore existing declared internal admission and demand boundaries, so no canonical product-documentation update was required. Compatible concurrent hunks, including FX91's prior fixes and the named other lanes, were preserved.

Residual risk: public package compilation remains blocked at the foreign theme seam; the three foreign MCP cases need their owners' adjudication; and the installed CLI still refuses the exact retained copy. The loaded failed conjunct and post-load repair remain unverified. Integration must load the coherent source, repeat exact UI/CLI inspection, and measure loaded idle traffic before claiming runtime acceptance. Native Windows/macOS and physical-device execution were not exercised; no new platform-specific production path was added.

RELOAD NEEDED: `apps/cli/src/api/externalActionExecutionAuthorization.ts` in the CLI consumed runtime; `apps/cli/src/settings/prompts/hydratePromptLibraryCatalog.ts` in daemon/Session consumers, together with the retained FX91 reload closure. Integration-owner reload only; none performed.
STATUS: BLOCKED
