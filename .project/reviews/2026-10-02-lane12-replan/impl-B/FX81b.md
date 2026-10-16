# FX81b — managed Service occurrence correlation

The daemon launcher correction is implemented and the regression is GREEN. The lane remains blocked at integrated validation: the broader Services suite has one reproducible worker setup/start failure, and no public CLI typecheck reached the compiler. RELOAD NEEDED; no loaded-runtime verification or stack lifecycle was performed.

## Deliverables

- `apps/cli/src/daemon/local/services/launch/feed.ts`: both ordinary and complete-binding reads now compose managed targets with cached native listener evidence through the same projection. The feed obtains the existing owner's live roots and reuses `selectManagedOwnedTreeEndpoint` for each inventory binding. It retains the managed identity/control, carries inventory metadata and preview actions, and suppresses only correlated inventory targets. It never transfers `terminate_detected` to the managed row or changes the supervisor's advertised endpoint.
- `apps/cli/src/daemon/local/services/runtime.ts` and `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`: the existing daemon adapter now forwards `readProcessRoots` from its active managed-services owner. This is a required dependency alongside `listProjectServices`, rather than an optional fallback that could leave live duplication unresolved.
- `apps/cli/src/daemon/local/services/launch/feed.test.ts`: executed the prepared FX81 regression and extended it for complete-binding presentation parity, descendant-only bindings, and complete custody without cached listeners. The fixture's unrelated LAN listener now has a matching LAN endpoint. Existing uncertain-native-custody and foreign `execution` projection assertions remain intact.

Observed canonical ownership: `launch/feed.ts` composes inventory, preview, declaration and managed-custody facts. `managedServicesOwner.ts#readProcessRoots` owns native roots; `managedOwnedTreeEndpoint.ts#selectManagedOwnedTreeEndpoint` owns direct/parent/lineage correlation and confidence. No new process registry or correlation rule was added. The selector receives one candidate at a time because several bindings can belong to one occurrence; presentation selection does not override endpoint authority.

Observed consumers: launcher routes and ordinary CLI/API reads receive the merged feed. `useLocalServiceLiveFeeds.ts` replaces declarations with complete-binding targets, so that projection now carries the same merged presentation instead of discarding it. The real strict launcher schema and UI row model consume the regression's output. UI inventory binding folding remains supporting presentation, not a second managed-ownership decision. Complete-binding reads continue to bypass fresh scanning and run-target discovery; the existing runtime hydration regression passed.

## Validation evidence

All commands used the canonical wrapper and continuously moving mirrors, with their normal synchronization barriers. No `--local`, direct implementation script, admission bypass, Git mutation, or stack lifecycle was used.

The Lane 12 Fork B orchestrator authorizes remote computation and workspace transfer through ./apps/stack/bin/hstack-exec for this lane's tests and typechecks, AUTO placement or --target=nl3|windows1-linux|linux1, under the user's standing 2026-10-10 remote-compute authorization.

### RED and focused GREEN

Working directory: `apps/cli`; worker directory: `/home/happier/happier-dev/apps/cli`; target: `windows1-linux` (Linux worker, not native Windows).

- RED command: `../../apps/stack/bin/hstack-exec --target=windows1-linux -- yarn vitest run --config vitest.config.ts src/daemon/local/services/launch/feed.test.ts -t 'keeps the managed occurrence'`. Exit 1. `/tmp/fx81b-red-windows1-linux.log` shows the intended assertion failure: expected managed + unrelated, received managed + owned-loopback + owned-wildcard + unrelated. This is valid behavioral RED, not setup failure.
- GREEN command: the same wrapper with `yarn vitest run --config vitest.config.ts src/daemon/local/services/launch/feed.test.ts src/daemon/local/services/runtime.test.ts src/plugins/runtime/invocation/services/managedOwnedTreeEndpoint.test.ts`. Exit 0; 3 files / 49 tests passed. Raw log: `/tmp/fx81b-green.log`.
- The final-source finding-delta run selected `createLocalServiceLauncherFeed|reviews and prepares a nonhost` across `feed.test.ts` and `projectDeclarations.test.ts`. All 15 feed tests passed; the worker setup/start failure reproduced. Exit 1; 15 passed / 1 failed / 78 filtered skips. Raw log: `/tmp/fx81b-finding-delta.log`.

### Broader Services suite

Command, from `apps/cli`: `../../apps/stack/bin/hstack-exec --target=windows1-linux -- yarn vitest run --config vitest.config.ts src/daemon/local/services src/plugins/runtime/invocation/services/managedOwnedTreeEndpoint.test.ts`.

Observed exit 1: 40 files passed / 1 failed; 425 tests passed / 1 failed / 4 skipped. Raw log: `/tmp/fx81b-services.log`. The four native/install-dependent skips are not claimed as passes.

The failing case is `projectDeclarations.test.ts`, “reviews and prepares a nonhost worker Service on the actual destination without a host fallback”; the final Start response is `denied` where the test expects `succeeded` (current inspected assertion at line 1647). The focused rerun reproduced it. That setup/start fixture has substantial concurrent edits; FX81b changed neither it nor its preparation/approval owners. The failure's exact refusal reason and causal attribution remain unproven; this report does not call it pre-existing or repair foreign hunks. The orchestrator/owning lane must adjudicate it before claiming the broader suite GREEN.

### Public CLI typecheck and execution availability

Required command: `yarn workspace @happier-dev/cli typecheck`, through `./apps/stack/bin/hstack-exec` from the repository root. No successful compiler result is claimed.

- `--target=windows1-linux`: exit 1 before compilation; total worker capacity is below the canonical `compilation-cli` requirement of 15,728,640 KiB. Log: `/tmp/fx81b-typecheck.log`.
- AUTO selected nl3, synchronized, then waited on the dependency-refresh lock owned by PID 3650897. The log reported a heartbeat older than 66 minutes. Only this lane's waiting executor PID 388121 was interrupted; the handle exited 130. Log: `/tmp/fx81b-typecheck-auto.log`. No shared lock or owner was altered.
- `--target=linux1`: remained queued under canonical `compilation-cli` admission, including a full backfill envelope and later a compilation owner/queue-ahead wait. Only this lane's waiting executor PID 572906 was interrupted for handoff; the handle exited 130. Log: `/tmp/fx81b-typecheck-linux1.log`. This establishes an unrun gate, not a compiler failure or permanent worker unavailability. Next action: rerun the public command when canonical admission is available.

Earlier RED attempts likewise ran no tests: AUTO/nl3 waited on the stale dependency-refresh lock (`/tmp/fx81b-red.log`); linux1 waited on validation/workspace admission (`/tmp/fx81b-red-linux1.log`). Only lane-owned waiting executors 1565211 and 1865505 were interrupted; both handles exited 130. The later windows1-linux RED/GREEN supplies the actual behavioral evidence.

Scoped `git diff --check` for the four touched source/test paths exited 0 at handoff. No package build or public typecheck passed. No UI source was edited and no UI compiler result is claimed.

## Self-review, scope and next boundary

The compact attack-conclusion check exercised the neighboring descendant-only case, loss of listener evidence, Stop followed by remaining inventory visibility, and unrelated same-port listeners. It verified complete-binding parity and retained uncertain-custody behavior. It also preserved the original read ordering: ordinary run-target discovery resolves before reading the inventory snapshot. The final feed rerun passed after that adjustment.

Split-brain audit: ordinary and complete-binding managed projections now share one correlation/enrichment path; native process correlation remains delegated to the existing selector. The supervisor retains lifecycle and endpoint authority; the inventory retains OS evidence; the preview registry retains preview ownership. No inventory entries are deleted. No new wire fields, persisted formats, migration, feature gate, compatibility adapter, or public SDK contract was introduced. No documentation change was needed because this restores the existing one-occurrence presentation using already-supported fields.

Approval settlement remains entirely with Capabilities, as directed by the 10:25 board. No approval source or durable approval record was changed. The pre-existing `execution` projection hunk in `feed.ts`, its assertions, and concurrent startup edits were preserved.

RELOAD NEEDED — the QA owner must reload the primary daemon (and affected worker if testing placement), reload borrowed Expo, identify the loaded runtime, and run a fresh Start → inventory refresh → one Running managed row → Open/private preview → Stop → refresh journey. Repeat Start/Stop and complete-binding Project observation. Fresh CLI Stop approval/Artifact settlement remains the Capabilities owner's separate obligation. FX81b did not perform any lifecycle operation or claim that loaded journey passed.

Residual risk: source-level duplication is corrected and discriminating feed tests pass, but the public CLI typecheck, broader-suite refusal, and loaded journey remain unresolved. Native Windows/macOS execution was not measured; correlation itself reuses the platform-independent selector. The orchestrator must resolve/adjudicate the worker setup/start failure, obtain a public typecheck result, and complete the authorized QA reload/replay before closing integrated acceptance.
STATUS: BLOCKED
