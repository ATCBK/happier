# FX88h — Lane 12 Fork B

Implemented the scoped approval-scheduling and projection-locality fixes, but acceptance is incomplete. Approve still measured **4,867.60 ms**, exceeding the **300 ms** target. Final clean-page quiet duty passed at **0.0541%**; busy duty measured **26.8641%**, below the predecessor's observed 45.2605% but above the historical 15.8% reference. Public UI typecheck failed with **613 diagnostics**; an adjacent Artifact suite retains **five failures**. These failures are not waived or certified pre-existing.

## Delivered changes and canonical ownership

- `apps/ui/sources/sync/ops/actions/actionAccountContext.ts`: exact Artifact preparation no longer waits for `sync.awaitBootstrapForegroundAcquisition()`. That wait belongs only to background `listArtifacts`. Account capture, encryption preparation, Artifact reads, admission, provenance, revision checks and CAS remain in their existing owners. This does not move the ACT-UNIFY boundary.
- `apps/ui/sources/sync/api/externalActionAccountTransport.ts`: non-finite own-Machine actions can reuse a current full inventory row through the existing `resolveFreshMachineAdministrationExecutionTarget` owner. The captured Account scope and custodian must match, and both reused and fetched rows pass the same bootstrap schema. Unavailable/non-current inventory falls back to the existing full read. Finite placement, requester invocations, foreign custody and signed/private custody verification retain fresh reads.
- `apps/ui/sources/sync/domains/plugins/availability/reader.ts`: immutable unchanged facts and installation UI models retain identity across fresh readers. The cache stays with the Availability producer and Account scope; admission wrappers and cursors remain current. Ordered-row retention also preserves an unchanged sibling when another materialization changes.
- `apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection.tsx`: retain equivalent installed declaration inputs instead of rebuilding the merge/union on unrelated reader publications.
- `apps/ui/sources/sync/domains/machines/reachability/useMachinePresenceSummary.ts`: subscribe/cache against the actual Machine inventory, status, presence and clock inputs instead of unrelated whole-store publications. Presence-map changes remain inputs so a real heartbeat recovers a Machine after expiry.

Six existing test files were strengthened or repaired: `sync.routeAcquisitionPriority.test.tsx`, `defaultActionExecutor.approvals.test.ts`, `actionAccountContext.artifacts.test.ts`, `availability/reader.test.ts`, `usePluginUiProjectionCurrentness.test.tsx`, and `hooks.useMachinePresenceCounts.test.tsx` under their existing UI owners. Changes were layered on current shared bytes; unrelated hunks were preserved.

Visible changes are scheduling/responsiveness only. No components, copy, styles, layout or interaction contract were added. No documentation page was changed because this restores the existing acquisition-priority and projection-locality contracts rather than introducing a new public contract. FX88g's Worker lifetime/reuse and reader-pending changes were preserved.

## Cause and falsifiers

**Observed:** at lane entry, exact Artifact reads and writes inherited the routed-Session foreground-acquisition wait through shared Artifact preparation. A composed test held real routed acquisition and profile work, then executed a schema-valid approval through the real default executor and Artifact HTTP boundary. Approval remained pending before the change and persisted its executed decision after it. Background inventory still waited. This proves a reachable user-action/background wait; it does **not** prove that the entire historical 18-second window had that cause.

**Observed:** a live Availability comparison contained 1,967 materializations, 33 declaration Machines and 69 plugins. Two refreshes retained the same materializations, snapshots and releases while all 69 response cursors changed. Fresh reader/model identities propagated through installed declarations, merge/union and projection. The producer and composed tests now distinguish unchanged descriptive inputs from genuine catalog changes and current admission facts.

**Self-review changes:** an initial Machine-request matcher missed query strings and was corrected before claiming RED. A CLI-origin voice fixture was invalid for client replay and was replaced with the real MCP-origin contract. Narrow presence filtering initially broke post-expiry heartbeat recovery; a genuine recovery RED test drove the presence-map correction. A two-installation RED test exposed sibling identity loss on partial refresh and drove row-local retention. No extra authority, protocol, timer, gate or persistence mechanism was added.

**Split-brain audit:** Artifact preparation/listing remains Account-context owned; full-Machine eligibility delegates to Administration rather than adding another readiness policy; installed UI descriptions remain Availability-owned and AppShell consumes them. Fresh private/finite reads intentionally remain distinct from reuse of a current own non-private transport target. They enforce different reachable custody contracts, not competing execution authority. Server admission/CAS remains authoritative.

## Remote validation

The brief's standing 2026-10-10 remote-compute/workspace-transfer authorization was used. Tests and compilation ran through `./apps/stack/bin/hstack-exec` AUTO or an authorized explicit target; never `--local`. No stack lifecycle or Git mutations were performed.

| Check | Observed result and evidence |
| --- | --- |
| Approval independent of held acquisition | Intended RED: `/tmp/happier-fx88h-route-red.log`. Focused GREEN: `/tmp/happier-fx88h-route-green2.log`; full three-scenario GREEN in the adjacent run below. |
| Current full-Machine reuse | Intended RED: `/tmp/happier-fx88h-machine-red2.log` (unnecessary Machine HTTP request). GREEN: `/tmp/happier-fx88h-machine-green.log`; final current/unavailable/no-inventory cases also passed in the full approval suite. |
| Approval, route acquisition, private origination | 48 + 3 + 9 = **60 passed** in `/tmp/happier-fx88h-approval-adjacent.log`. The same command failed overall because the fourth, Artifact suite failed. |
| Adjacent Artifact suite | Its missing real Sync test bootstrap was repaired. Final **21 passed, 5 failed** in `/tmp/happier-fx88h-artifacts-green.log`: three Settings reversal/receipt expectations and plain/e2ee ordinary CRUD returning `approvals_not_supported`. Unattributed outside this lane's production changes; not silently fixed. |
| Projection producer/composed regression | Intended producer/composed RED and focused GREEN; `/tmp/fx88h-projection-green.log` has two focused passes. Adjacent four-file run: **72 passed**, `/tmp/fx88h-projection-adjacent.log`. |
| Partial materialization refresh | Intended sibling-identity RED: `/tmp/fx88h-partial-refresh-red.log`; final reader suite **32 passed**, `/tmp/fx88h-partial-refresh-green.log`. |
| Final projection/presence composition | **37 passed**, `/tmp/fx88h-projection-composed-final.log`, after the final row-retention change. Includes post-expiry heartbeat recovery. |
| Existing target-selection/subscription contracts | **5 passed**, `/tmp/fx88h-transport-owner-review.log`; independent review found no material own-Machine qualification defect. |
| Public UI typecheck | `hstack-exec -- corepack yarn --cwd apps/ui -s typecheck`: **failed**, final `/tmp/happier-fx88h-ui-typecheck-final.log`, 613 diagnostics. Exact diagnostic inspection found none naming the eleven touched source/test files. This is not a green package gate. |
| Whitespace integrity | Scoped `git diff --check` passed after final source edits. |

Two explicitly pinned validation attempts were cancelled before dispatch while waiting on existing foreign locks/reservations; AUTO was used afterward. Foreign owners were not terminated. Earlier invalid fixture/matcher attempts were not counted as RED/GREEN evidence.

## Live QA and measured limits

Used only this lane's managed remote browser `fx88h` on nl1 against existing `agent-qa-l12-b` Home `:3026` and borrowed Expo `:19364`, with HMR disabled. Busy sign-in read the documented `dev-test-account.key` into the real Recovery key field in memory only. Quiet sign-in used the authorized `qa/fx82f-account.key`. Neither forbidden key path was accessed, and no credentials, request bodies or session plaintext were printed or saved in the probes.

Evidence is under `impl-B/qa-shots/FX88h/`:

| Observation | Result |
| --- | --- |
| Initial approval trial | `approval-before.json`: handler→decision fetch **5,175.17 ms**. |
| Final approval trial | `approval-final.json`: **4,867.60 ms**. Machine transport starts at +3,246.1 ms; a fresh Machine GET starts at +3,247.8 ms. Artifact read spans were 1,292.8 ms and 568.8 ms; Artifact update was 1,184.0 ms. Do not also add their nested HTTP/encryption spans. Most observed transport resolutions were sub-millisecond; the largest was **89.2 ms**, not an 18-second wait. Observed foreground waits were at most 0.8 ms. |
| Busy while row inventory grew | `busy-duty-final.json`: **44.6404%**, 120.008 s, 241→310 rows, ten full Sessions. |
| Settled busy, before last retention-only delta | `busy-duty-settled.json`: **32.2540%**, 120.005 s, 310 rows stable, ten full Sessions. |
| Final current-source busy | `busy-duty-current.json`: **26.8641%**, 120.004 s after 120 s warm-up, 309→311 rows, ten full Sessions. |
| Final current-source quiet | `quiet-duty-clean.json`: **0.0541%**, 120.004 s after 120 s warm-up, five rows and five full Sessions stable. Passes ≤1%. |
| Busy CPU profile | `busy-profile-final.json`: 32.886 s sampled; zero samples named `AppShellPluginUiProjectionProvider` or `mergeInstalledPluginUiProjections`; React root inclusive time about **2.008 s**, versus the predecessor's roughly 24.2 s/40.5 s. Profiled duty was 21.22%; this is not the unprofiled duty result. |
| Loaded source | `loaded-source-current.json` confirms the final row-retention, declaration-retention, presence-recovery and exact-Artifact preparation factories. The Machine transport factory is registered but uninitialized on this Session page; its live exercise is the earlier approval trial, before only the final projection-row retention delta. |

The first quiet duty result (1.50%) is **discarded as contaminated**. `quiet-profile-final.json` showed losing sign-in `Promise.race` locator waits continuing accessibility queries; React root work was only 10.58 ms/63.15 s sampled. The corrected probe closes the sign-in page, opens a clean authenticated page, then warms and measures without those waiters. That produced the final 0.0541% result. The predecessor quiet probe used the same waiter pattern, so its 1.27% is not a controlled product baseline.

Busy traffic/corpus progression differs across captures, so the percentages are observations, not an isolated causal speedup estimate. The final profile predates only the small sibling-retention correction; final unprofiled busy/quiet duty and the 37-test composed rerun include it. No release/artifact certification or device QA is claimed.

## Cleanup, remaining work and risk

Both lane-owned Script operations reached terminal `failed` states, verified through canonical `action.operations.get`: `bf96eacd-f303-4d66-9e2e-c63023b00da0` and `a59e0c91-3ab5-44c9-a009-069b0a7d64b5` (`operation-final.json`, `operation-second-final.json`). No lane-owned operation remains running. Quiet contexts were closed. The owned browser launcher was interrupted; CDP returned `ECONNREFUSED`, and an exact nl1 check verified both PID 3145895 and its temporary browser profile were absent. No foreign browser or Stack process was stopped.

- **[blocked] Approval acceptance:** the remaining measured path is serial Artifact/network/CAS and Machine I/O, not a long foreground or socket-acquisition wait. Coordinate the remaining HTTP/Artifact timing with FX89 without moving ACT-UNIFY admission/CAS. The historical 18-second wait is not exactly attributed by this lane's live evidence, and <300 ms remains unproved/unmet.
- **[blocked] Integrated validation:** triage the five Artifact failures and the final 613 compiler diagnostics with their owning lanes, then rerun the failed suite and public UI typecheck on integrated source. None is presented as this lane's proven pre-existing failure.
- Busy duty moved toward the reference but did not reach 15.8%; remaining sampled work includes React element creation, base64/crypto and development overhead outside the removed projection hotspot. Further attribution requires a controlled busy workload; no speculative cache or wider refactor was added.
- Residual risk: current own-Machine reuse depends on the canonical live/settled inventory qualification; foreign/private/finite paths deliberately retain fresh discovery. Only web QA ran; no native-platform performance claim is made.

RELOAD NEEDED: apps/ui/sources/sync/ops/actions/actionAccountContext.ts; apps/ui/sources/sync/api/externalActionAccountTransport.ts; apps/ui/sources/sync/domains/plugins/availability/reader.ts; apps/ui/sources/components/appShell/plugins/AppShellPluginUiProjection.tsx; apps/ui/sources/sync/domains/machines/reachability/useMachinePresenceSummary.ts
STATUS: BLOCKED
