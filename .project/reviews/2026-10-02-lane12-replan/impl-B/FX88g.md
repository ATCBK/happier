# FX88g — Worker lifetime, reader-pending hydration and remaining UI latency

Partial implementation; acceptance remains blocked. Web Worker reuse/failure recovery and matching reader-pending hydration are corrected at their owners. Approve remains **20,915 ms** against <300 ms; final unprofiled cold body is **7,108 ms after bundle** against ≤3,000 ms; quiet/busy duty samples are **1.27% / 45.26%**, above 1% / 15.8%. Public UI typecheck failed **580 diagnostics**, none in this lane's touched source/test files. Broader transcript adjacency failed **28/204** cases; it is not all-clear.

## Delivered source

- `apps/ui/sources/sync/encryption/nativeCryptoWorker/nativeCryptoWorker.web.ts`: one document-lifetime Worker transport shared across distinct Encryption adapters/scopes, rather than a Worker per dispatch. The existing array request/reply protocol is serialized; request keys are not retained between dispatches. Active/idle Worker failures retire it, queued cancellation leaves other callers intact, and retired callbacks cannot affect a replacement.
- `nativeCryptoWorkerRouting.ts` in the same directory: ordinary web-envelope failure/unavailability uses the existing Encryption `referenceRun` → `mapCryptoBatchWithYield` → Protocol `openEncryptedDataKeyEnvelopeV1` for that call. The existing dispatch controller cancels the failed call's abandoned batches before fallback; later calls may retry the Worker. Diagnostic `require` semantics remain.
- `apps/ui/sources/sync/syncEngine.ts`: the by-ID hydration entry now carries its Home, Encryption identity and currentness. A missing encrypted transcript reader joins only matching current hydration, retaining loading instead of projecting a transient terminal failure. After settlement, Account retirement and same-ID other-Home replacement are fenced; a genuinely missing reader without matching hydration, HTTP rejection and no-scope cases retain terminal behavior. Tests are in `sync.ensureSessionVisibleForMessageRoute.test.ts`.
- `apps/ui/sources/sync/domains/session/readState/sessionViewer.ts`: mechanical import narrowing to the existing public `@happier-dev/protocol/json/storedReadSchema` entry point, avoiding the broad Protocol barrel in cold viewer normalization. No schema or behavior change.
- `docs/encryption.md`: development-only Worker ownership, cancellation and fallback contract updated in its existing canonical paragraph. `docs/surface-states.md` has no conflicting reader-terminal promise and needed no change.

These are layered hunks in a shared moving tree, not ownership of every existing diff in those files. Concurrent `types.ts`, Sync, compiler and other lanes' work was preserved. No approval/settlement, server, daemon, Worker asset, styling or feature-gate changes were made.

## RED → GREEN and package gate

All tests/compiler commands used `./apps/stack/bin/hstack-exec`, AUTO or the authorized remote targets, under the brief's standing remote computation/workspace-transfer authorization. No local compiler/test runner or `--local` was used.

| Check | Observed terminal result | Evidence |
| --- | --- | --- |
| Worker composed RED | exit 1, 13 failures: recreate/concurrent Workers, failed fallback and malformed replies | executor handle `93876` |
| Idle Worker error RED | exit 1, 2 failures | handle `44636` |
| Abandoned bulk queue RED | exit 1, 1 failure: fallback completed but another abandoned 64-item dispatch remained | handle `66112` |
| Final Worker/encryption adjacency | exit 0, **17 files / 145 tests**, including all **25 composed web tests** | handle `90735`; exact terminal excerpt below |
| Reader-pending RED | exit 1, 2 intended failures while exact HTTP response remained held | `/tmp/fx88g-transcript-red.log` |
| Final reader/terminal/retirement focused GREEN | exit 0, **11 passed / 195 skipped**; 206 collected | `/tmp/fx88g-transcript-green-focused.log` |
| Earlier full transcript adjacency | exit 1, **176 passed / 28 failed**, before the two additional retirement/foreign-Home cases; final focused run consumed the final fixtures | `/tmp/fx88g-transcript-green-adjacent.log` |
| Viewer existing suite | exit 0, **8/8** | `/tmp/happier-fx88g-viewer-green-linux1.log` |
| Public UI typecheck | exit 1, **580 TS diagnostics**, zero attributed to touched files by filename | `/tmp/happier-fx88g-ui-typecheck.log` |
| Scoped final diff whitespace check | exit 0 | `git diff --check` over touched source/test/doc/probe paths |

Final Worker command: `./apps/stack/bin/hstack-exec --target=linux1 -- corepack yarn --cwd apps/ui -s vitest run sources/sync/encryption/nativeCryptoWorker sources/sync/encryption/cryptoGoldenVectors.test.ts sources/sync/encryption/encryption.nativeDataKeyEnvelopeContract.test.ts sources/sync/encryption/encryptionTelemetry.test.ts sources/sync/encryption/encryption.defaultNativeCryptoWorkerRouting.test.ts`.

Delegated executor's exact terminal output: `nativeCryptoWorker.web.test.ts (25 tests) 27688ms`; `Test Files 17 passed (17)`; `Tests 145 passed (145)`; `Duration 86.70s`; `exit_code: 0`. These Worker runs were not saved to separate raw log files; their tool handles are the execution evidence. Parent independently inspected the current transport/routing and measured its loaded real Worker path.

Final transcript command: `./apps/stack/bin/hstack-exec --target=linux1 -- corepack yarn --cwd apps/ui -s vitest run sources/sync/sync.ensureSessionVisibleForMessageRoute.test.ts sources/sync/sync.sessionMissingServerScope.test.ts -t 'keeps a missing transcript reader loading|keeps retry semantics.*missing encryption|keeps retry semantics before first session snapshot|reports the HTTP status of a failed hosted transcript page|fetches plaintext session messages|does not restore a cross-device-deleted|requires fresh hydration when encryption changes'`.

The new held-response cases cover available, forbidden, Account-retired and same-ID other-Home outcomes through composed Sync/HTTP wiring. Worker coverage includes cross-instance reuse, constructor/post/message/runtime/malformed failures, idle failures, recovery, active/queued cancellation, late replies, wrong-recipient vectors, scope retirement and healthy 500-envelope work beyond five seconds.

The full transcript failures include fixture-unhandled background `/metadata-upgrades`, `/active` and `/sessions` requests, pinned catch-up/known-locked expectations, and a pending-delivery fixture supplying an empty Encryption object. Inspected examples bypass the new missing-reader join, but the complete set remains **unattributed**, not certified pre-existing. No foreign fixtures were repaired. Public compiler failures span routes, Settings, imported CLI and other owners; zero touched-file diagnostics does not make the package green. Prerequisite-only cancelled attempts were never counted as RED or GREEN.

Public compiler command: `./apps/stack/bin/hstack-exec --target=linux1 -- yarn --cwd apps/ui -s typecheck`. No separate build/package-green claim is made.

## Live observations — borrowed `agent-qa-l12-b`

The existing Expo19364 / Home3026 stack was borrowed without stack lifecycle changes. Own canonical remote browser `fx88g` ran on nl1. Busy sign-in used only the documented dev-test Account key via the normal Recovery key UI, in memory; quiet used only the authorized `qa/fx82f-account.key` fixture. No key, decrypted content or file names were emitted. Both expected Account identities were checked in memory.

Content-free evidence and the reusable probe are in `impl-B/qa-shots/FX88g/`:

- **Approve:** `approval-before.json`, own Artifact `f8de99d8-fb10-4b13-a701-ea609e24bd37`, handler→first decision fetch **20,915.0 ms**. Account capture1.2ms and Settings0.1ms; two initial Artifact reads3,647.2/591.5ms. Machine transport starts18,079ms after handler, then a fresh full-Machine read takes2,818.7ms. The 26.605s profile includes16.610s idle and4.311s program time, so this is not explained solely by one synchronous Workflow long task. Concurrent account-wide requests cannot all be assigned to this approval.
- **Canonical approval cause/authority:** Protocol `actionExecutor.ts` reads the Artifact around9839, persists approved around10030, checks currentness around10052, then delegates around10082. UI `defaultActionExecutor.ts`'s `approvalsUpdate` performs fresh Artifact/CAS/provenance work before `executeOriginalAccountMachineAction` sends the exact-daemon decision. Moving that admission/CAS boundary into exact-daemon delivery changes the excluded **ACT-UNIFY** seam. No local bypass was added. Approved→executing remains separately fenced; this is not a claim of duplicated effects. The own Script operation `14aab54a-a5c0-4a40-95ea-1e7dffe7d34a` ultimately settled failed with `project_command_step_failed`; no own operation remains running. The separate Triage11.7s cold-currentness capture was **not** an Approve trace.
- **Fresh390 Files:** `files-final.json` records an available reader, no route hydration loader and one physical Worker across many dispatches. First observed Worker startup round-trip was805ms; later responses reused it. A second fresh navigation in `files-tree-final.json` first showed a terminal tree-unavailable state with the reader already available. Later `files-snapshot-final.json` on that same page has **Files row markers, tree mounted, zero tree progressbars and no tree error**. Its raw `fileRowCount: 6` counts row-prefixed testIDs, potentially including child markers, not necessarily six distinct rows. This proves eventual Files availability, not an18.2s listing-time claim or the cause of the intermediate tree state.
- **Real Worker contract:** `worker-final.json`: three separately created Encryption instances each completed a real envelope round-trip; wrong-recipient input returned null. The document observed one Worker total and zero Worker error events. Round-trips1,862/756/475ms include renderer/background contention; they are not isolated cryptographic CPU timings. Background dispatch events were not attributed to individual test calls.
- **Loaded source:** `loaded-source-final.json`, observed2026-10-17T02:29:10.165Z: shared transport, final dispatch-lifetime cleanup and reader hydration join all present in initialized module factories. The Worker asset itself was unchanged. Initial blank/SOCKS/incomplete-bundle attempts and an interim diagnostic that terminated observed Workers were excluded from acceptance; their browser lifetime was retired before final QA.
- **Cold:** `cold-final-unprofiled.json`: bundle ends7,784.697ms, retained Session surface appears14,892.400ms → **7,107.703ms after bundle**, no page errors. Earlier captures were17,198.730ms unprofiled and9,673/10,919ms profiled after bundle (`cold-before-*.json`). Different scheduling/corpus and profiler overhead prevent assigning the entire difference to the import change. The final marker is a retained body, not completion of drafts or every transcript read.
- **Duty:** after readiness and120s warm-up, each sample measures120s `Performance.TaskDuration`: `quiet-duty-final.json` **1.2746%**, five Sessions/rows stable; `busy-duty-final.json` **45.2605%**, ten full Sessions, rows271→311, drafts ready throughout. Both fail the stated limits. Ongoing busy publication limits comparison with FX88f; it does not turn this result into a pass.
- **Remaining CPU:** a separate bounded `busy-profile-final.json` has40.505s sampled span despite a nominal30s observation. React root work is24.160s inclusive; AppShell plugin projection provider5.135s; React development `logComponentRender`4.796s; GC3.247s; canonical Base64 validation0.898s self. These categories overlap. This identifies a remaining projection/render corridor, not a proved feedback-loop cause or allocation-retainer claim. The canonical Account lifetime capture was inspected and is identity-stable, falsifying the simple "new lifetime on every render" hypothesis. This profiled observation is not an unprofiled duty acceptance sample.

Visible change for design review: the existing loading state stays in place while its exact reader is being installed; genuine failures still use existing terminal states, and Files uses its existing tree. No new styles/components/copy. DOM/state checks were performed; a pixel-level visual comparison and a real embedded-transcript loading→messages/rejection replay remain unrun. Native iOS/Android were not live-tested; native adapter regressions are covered by the remote source suite.

## Ownership, self-review and remaining work

Split-brain audit: browser transport lifetime remains in the web adapter; routing alone chooses the existing canonical reference implementation; Protocol still owns envelope parsing. Distinct adapters retain queue/capability scope, not separate physical Workers. Sync's existing by-ID hydration map alone owns reader installation/waiting; no UI-local retry, readiness flag, timer or second decryption path was introduced. Genuine missing-reader/no-scope paths intentionally remain as terminal paths, not competing hydration owners. Approval authority was not forked.

The existing native deadline remains at the dispatch owner. The already-present correction excluding a whole web inventory from that native aggregate timeout was preserved: healthy first6s and500-envelope work beyond5s pass. **Residual risk:** web work that produces no completion, error or caller cancellation has no separate per-dispatch timeout and can remain pending; this lane did not invent a new deadline or timer.

[blocked] ACT-UNIFY owner must coordinate exact-daemon fresh admission/decision CAS/currentness with original requester custody, then replay real busy Approve to <300ms. Raw RPC is not an indiscriminate replacement for the HTTP custody path.

[blocked] Cold≤3s and quiet/busy duty limits remain unmet. Continue causal profiling and owner-level RED/GREEN through the AppShell/projection/render corridor; the captures above do not justify a guessed cache, cap, timeout or weakened currentness check.

[blocked] Resolve/adjudicate the28 transcript-neighbor failures and580 public UI diagnostics, rerun the affected gates, and perform the embedded-transcript live replay/pixel review. No implementation-complete or package-green verdict is supplied.

All owned browser and validation operations are terminal. Final canonical browser owner exited on Ctrl-C; its exact CDP44859 endpoint and earlier owned40307/42237 endpoints are unreachable. No foreign browser/process/profile, Stack lifecycle, Git index/branch or unrelated work was changed. No unapproved summary/status artifact was created.

RELOAD NEEDED: full page reload for `apps/ui/sources/sync/encryption/nativeCryptoWorker/nativeCryptoWorker.web.ts`, `nativeCryptoWorkerRouting.ts`, `apps/ui/sources/sync/syncEngine.ts`, `apps/ui/sources/sync/domains/session/readState/sessionViewer.ts`; no Worker asset or server/daemon restart required.
STATUS: BLOCKED
