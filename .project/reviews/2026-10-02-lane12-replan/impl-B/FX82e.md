# FX82e — one verified row fan-out correction; the idle objective remains open

Partial implementation. The canonical Session drag binding now retains its identity when its facts and methods are unchanged. Its real interaction-hook regression proves RED → GREEN, and the adjacent 32-test corridor passes. The strengthened real-store/150-row composition also passes: unchanged writer updates publish nothing, and one changed Session renders only its row. **This is not a complete idle fix.** Browser captures still show substantial refresh/hydration work, repeat envelope openings and unrelated component scheduling. The public UI typecheck emitted errors outside this lane's three edited files and was stopped after those failures; package clearance is blocked.

## Deliverables

- `apps/ui/sources/components/sessions/shell/useSessionListEntityDragDrop.ts:441`: retain the existing returned binding with `React.useMemo`, using all five returned fields as dependencies. This corrects the originating identity, rather than adding a comparator to every row. No registry, timer, cache, public interface, persistence, encryption policy or gate was added.
- `apps/ui/sources/components/sessions/shell/useSessionListRowInteractions.lifecycle.test.ts:33`: real interaction and entity-drag owners, with a memoized callback consumer, distinguish unchanged updates from a new drag binding. The final RED produces one unwanted consumer render; GREEN produces zero. Existing pointer/keyboard cancellation, source retirement and subsequent pickup tests remain exercised. The small test consumer is not represented as the complete production Session-row tree.
- `apps/ui/sources/sync/store/hooks.sessionListRowProjection.test.tsx`: extend the existing three-Home/150-row composed test to submit equivalent rows through `applyServerScopedSessionListRows` and count actual Zustand notifications. There are zero publications and zero extra row renders. The first changed row now also goes through that real writer, rather than a raw `setState`. It renders only that row; the existing 20 subsequent changes retain all sibling projections and yield 171 total row renders, including mount. Earlier FX82d parser-count changes in this file were preserved.
- Reproducer, count traces, CPU profiles and validation logs: `../qa-shots/FX82e/`. Captures contain component names, source stacks, field names and aggregate counts, not Session contents, ciphertext bytes, credentials or opened keys. Envelope identities and recipient material stay in browser memory only and are cleared after capture.

Visible changes: none. Existing controls, layout, styles, accessibility and interaction policy remain intact. UI craft constrained this to the existing Home, list and drag owners. No product-documentation update is needed for unchanged user flows and formats. This is development-source evidence, not release certification.

## Verified cause and owner audit

The live row boundary is already memoized. Its `onDragStart` comes from `useSessionListRowInteractions`, whose callback depends on the object returned by `useSessionListEntityDragDrop`. That hook returned a fresh object on every render even when its runtime, scope, target and methods were unchanged. The resulting callback identity invalidated every mounted row. In `warm-before.json`, 2,575 row executions were in commit groups reporting only `onDragStart` changes, including the one retained-draft callback variant. Another 1,125 row executions reported no changed props; those are not attributed to the corrected binding.

Source audit: the interaction hook is the sole production caller of `useSessionListEntityDragDrop`. Both pointer and staged keyboard carry paths consume this same returned owner. `SessionListRowViewModelBoundary`, `sessionListSessionItem` and `sessionListRow` retain their existing row-local subscription and interaction paths. No consumer-side equality workaround or second drag owner was added. The real Session row writer already reconciles unchanged rows and returns the previous root state; the composed test verifies it, so no additional writer guard was invented.

Activity's membership provider already memoizes its context value; its query lifecycle can still change that value. `useActivityAttentionSource` recreates its store selector when the membership-map identity changes. These were inspected, but this lane has not established a valid no-op failure through their full producer/provider composition. They were not blanketed with further memoization.

## Source verification and failed gates

The orchestrator/user's standing 2026-10-10 remote-computation/workspace-transfer authorization was used. All source tests and compilation ran through `./apps/stack/bin/hstack-exec`, pinned to **nl3**, `/home/happier/happier-dev`, with its synchronization barrier and continuously moving mirror. No `--local`, local compiler, Git mutation, foreign-process cancellation, Stack lifecycle or database operation was used.

- Deciding RED: `drag-final-red.log`, exit 1. With the original owner return and the corrected provider-preserving test update, the consumer renders once where zero is required. This is the applicable RED.
- GREEN and adjacent behavior: `drag-corridor-green.log`, exit 0, **32 tests across 3 files**: interaction lifecycle, the real interaction/Action corridor, and row projections.
- Final strengthened real-store composition: `store-composed-green.log`, exit 0, **1 selected test**; 150 mounted selectors, zero unchanged publications, one changed row only, 171 total row renders after the existing rapid-update sequence.
- Earlier attempts are retained, not promoted to evidence: `drag-red.log` waited on a foreign dependency-refresh lock and was cancelled, exit 130. `drag-source-red.log` selected a nonexistent package-local Vitest path; `drag-source-red-2.log` had a doubled config path. The initial `drag-owner-red.log`/`drag-green.log` used a raw renderer update that removed the testkit's provider wrapper; those render counts are discarded. The final RED/GREEN uses `screen.update`.
- `ui-typecheck.log`: the public UI typecheck reached compilation and emitted failures including `readSessionLayout1OwnerProjection.ts`, `actionFamilyTranslations.shared.ts`, `deriveThemeColors.ts`, SavedSecret reference/catalog operations, directory-tree response mutability and the external Voice host API fixture. These are outside this lane's three edited files. The lane did not modify them or claim they were independently pre-existing. The owned TTY-backed compiler was interrupted after failure evidence, terminal **exit 130**; this is neither a compiler pass nor a completed all-partition diagnostic census. The required package gate remains **[blocked]** until those owning changes are reconciled and the public check passes on current source.

## Live evidence and attribution limits

Canonical browser owner: `dev-targets browser start fx82e --stack=agent-qa-l12-b`, selected **nl1**, Chromium PID **1098111**, controller CDP **38909**. This is the explicitly authorized remote QA browser, not controller-local Chromium. Playwright attached to that owner. The expected QA Account was authenticated without printing or persisting credential material. Initial navigation selected the configured default Home and failed its capability probe; the owned browser was switched to the authorized QA Home, and the legacy connection-intent URL was removed before measurement. The first Home wait timed out; it is not a baseline.

Loaded UI: `/apps/ui/index.ts.bundle`, development React **19.2.0**, Home route `/`, HMR disabled. Later `loadedBasis.dragMemoReturn: true` checks the tail of the loaded production hook, not merely that the function contains some unrelated `useMemo`. React hook instrumentation is installed before renderer initialization and remains the same across the ablation/final comparison. There was no Stack reload or separate packaged/release representation.

Counts are committed function-fiber executions detected from changed `actualStartTime`, with the prior root seeded before capture. They exclude unchanged retained `PerformedWork` flags, aborted work and DOM nodes. The observer records store changed-field sets and writer stacks, timer callbacks, state/reducer owners, external-store notifications and per-commit top components. React's exposed renderer lacks the scheduling-profiler injection hook; the in-page hook records observable candidate schedules, not a proof that each setter actually changed its value or caused the next asynchronous commit. Several schedules can batch into one commit. **The historical 107 commits/min cannot be retrospectively assigned exact causes from its aggregate log, and exhaustive unique causal attribution remains open.**

`settled-after-summary-filtered.log` groups all **172** commits in one 60.114-second window. Selected exclusive groups (each commit is grouped once; mixed state owners remain explicit):

| Observed preceding schedule / publication group | Commits | Committed function executions | Leading components |
| --- | ---: | ---: | --- |
| Session row-map publication | 42 | 21,342 | View, VirtualizedListCellContextProvider, Text |
| PluginUiProviderInternal state | 9 | 8,176 | View, Text, LocaleProvider |
| AppShellPluginUiProjectionProvider + PluginUiProviderInternal | 5 | 7,685 | View, Text, AppShellPluginExecutionOriginSelection |
| Composer chip measurement + both plugin providers | 4 | 6,390 | View, Text, AppShellPluginExecutionOriginSelection |
| AgentInputScrollableChipRow state | 8 | 3,874 | View, VirtualizedListCellContextProvider, Session row wrappers |
| No captured state/store cause | 24 | 4,583 | View, Text, LocaleProvider, Session row wrappers |

All remaining groups and their top components are in that log and the raw per-commit JSON. The native adapter's `pushSurfaceContext` already suppresses identical semantic snapshots using `stableJsonStringify`; therefore the provider schedules alone do **not** establish that it publishes unchanged context. `PluginUiProviderInternal` adopts host snapshots and `AppShellPluginUiProjectionProvider` owns currentness/origin reports. Neither was modified on an unverified no-op hypothesis.

The original full attribution artifact exceeded command argument limits, and the launcher did not forward compressed stdin. Those analyzer failures are retained in the `attributed-before-summary*` logs. The successful routed analyzer receives a compact serialization that omits bulky external-notification records; the raw capture still retains them. No failed analyzer is presented as a successful classification.

## Performance result

The workload did not become a no-incoming-change Home. Entity counts sometimes stabilized while hydration/refresh publications continued. Representative windows, with raw count/window shown to keep the denominators auditable:

| Capture | Sessions / rows, before → after | Commits / count window | Function executions | Chromium duty |
| --- | --- | --- | ---: | ---: |
| `settled-before` | 309→309 / 713→713 | 292 / 61.875 s | 115,856 | 92.66% |
| `settled-after` | 286→286 / 713→713 | 172 / 60.114 s | 101,029 | 89.12% |
| `matched-ablation` | 286→286 / 713→713 | 137 / 62.433 s | 184,707 | 83.94% |
| `matched-final` | 286→309 / 713→715 | 140 / 60.020 s | 144,128 | 94.61% |
| `stable-final` | 309→309 / 715→717 | 141 / 60.661 s | 144,621 | 99.00% |
| `final-crypto` | 309→309 / 717→717 | 128 / 60.386 s | 125,718 | 85.07% |

The ablation delegates to the loaded fixed hook and returns a fresh copy of its binding, reintroducing only the pre-fix identity behavior for the capture; `finally` restores the original export. The following final capture consumes the actual loaded source. However, 23 Sessions and two list rows arrived between/within those measurements. The later attempted stable capture also gained rows. **These are not a matched settled before/after proof, and no total CPU speedup is claimed.** Duty uses CDP `TaskDuration / Timestamp`; its counter window differs from the count window, especially when collecting a large diagnostic result. Instrumentation and development overhead are present in these samples.

## Workflow and key-opening work still required

`settled-after` records **3,466 opens / 2,058 distinct envelopes / 1,408 repeat ciphertexts** while Session entity count stays 286. Of those, **135 opens, including 58 repeats**, reach `resolveWorkflowRunDataKeyV1 → projectPage` in Protocol's `workflowRunActions.ts`. The remainder reaches native-crypto reference batches. This refutes the explanation that all remaining openings are newly distinct Sessions. The initial recipient-object observation reports no repeated object identities; that does not distinguish fresh copies of the same key material from different keys and is not used to claim another Encryption instance or authority boundary.

The canonical Workflow list Action currently reopens the accepted snapshot in `projectPage`; exact Account-change materialization reaches that lean list owner, and UI library/window reads use it too. `Encryption.decryptEncryptionKeys` already owns successful scoped envelope retention; independent Action/cancellation lifetimes were deliberately retained by FX82c. **No new global plaintext/key cache or cross-invocation authority was added.** This lane has not completed changed-input-only Workflow projection or a valid owner-level repeat-opening RED/GREEN. These remain required implementation work, not completed optimizations.

The final sequential capture adds exact Session-envelope/plan correlation and byte-equality counting of recipient material without emitting it. `final-crypto.json` / `final-crypto-summary.log` observe **zero actual Session opens, zero Session decrypts requested and 534 retained Session-key hits**. Total openings are **1,058, all distinct, with zero repeats**, while both Session and row counts remain constant. All twelve background jobs whose launch was observed complete. The native batch callers include `resolveArtifactProvenanceDataKey → openArtifactProvenance → buildDecryptedArtifactListItem → decryptArtifactListItems`; API-request counts are kept separate from actual codec-open counts. The absence of repeats in this minute does not erase repeats in earlier windows. It establishes that residual opening is workload-dependent and is not explained solely by newly arriving Sessions. No extra cache was added for distinct envelopes. Temporary recipient comparison copies are zeroed and all diagnostic wrappers restored in `finally`.

The final observer records approximately **127.18 commits/min and 124,915.42 function executions/min**, with 85.07% Chromium duty. Stable entity counts and completion of observed jobs still do not mean zero incoming updates; this remains far from the requested near-zero idle outcome.

## Outstanding coverage and residual risk

- **[blocked] Package gate:** reconcile current UI compiler errors in their owning lanes, then rerun the public UI typecheck. Focused source GREEN does not waive it.
- **[blocked] Idle performance claim:** the shared QA Home continues receiving rows and refresh work. A no-incoming-change, acquired interval with the same loaded source/instrumentation is still missing. This lane has no authority to stop other QA programs or alter Stack/transport lifecycle to manufacture one.
- **Incomplete implementation:** finish Workflow changed-input projection, characterize repeats at the existing cryptographic lifetime owner, and discriminate provider/clock/composer no-op schedules through composed regressions. Exact attribution of every historical/current asynchronous commit is not established. The verified drag fix does not stand in for those requirements.

The compact self-attack exposed the provider-remount test error and invalid comparison corpus; both were corrected or excluded. Neighboring drag cancellation, source retirement, actual writer no-op admission and sibling row isolation ran. The source correction introduces no new owner or retained security material. Native/mobile/macOS/Windows performance, scroll/viewport behavior under native rendering and production-build comparison remain unmeasured. Overall residual risk is the failed package gate, incomplete residual-owner work and lack of a matched idle result.

Cleanup: every capture completed and restored its wrappers. The owned foreground browser launcher terminated after SIGINT, exit 1. CDP 38909 is unreachable (curl exit 7). Canonical exact-host browser-ownership cleanup inspection confirms both Chromium PID 1098111 and its temporary profile are absent (`browser-cleanup.log`). This inspection used the browser's selected nl1 host, not another source-validation target. All lane validation handles are terminal; foreign processes, locks, services and database state were untouched. Final scoped `git diff --check` exited 0. No Git mutation occurred.

RELOAD NEEDED: apps/ui/sources/components/sessions/shell/useSessionListEntityDragDrop.ts. The authorized QA browser loaded this source; any other application reload remains with its owner. Residual risk: compiler clearance, remaining Workflow/provider/clock/composer work and a matched no-incoming-change Home measurement are still outstanding.
STATUS: BLOCKED
