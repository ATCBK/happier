# FX82b — measured hot-owner reductions; idle saturation remains

Partial implementation, not a completed idle-loop fix. Five production owners and their five existing test files were updated. Protocol typecheck and 337 tests across the selected suites passed. Public UI typecheck exited 2 with errors outside this lane's edits and missing temporary test-membership configs. The loaded Home still reached 99.35% main-thread duty; a later capture was 74.73%. No near-zero idle result, overall speedup, persistent-leak diagnosis, or complete root-cause correction is claimed. The after-Run sample is also blocked on the explicit approval requested after automatic approval review rejected a follow-up approval-control click.

## Delivered source

Paths are relative to the repository root. These are this lane's changes, not ownership claims over other uncommitted hunks.

- `packages/protocol/src/crypto/base64.ts`: the existing strict padded-base64 decoded-length owner scans character codes in place. It no longer slices the ciphertext or runs its alphabet through RegExp. The alphabet, length, padding placement, unused low-bit checks, empty input and permissive decoder fallback contracts are retained.
- `apps/ui/sources/sync/domains/server/serverProfiles.ts`: one identifier projection supplies lookup, durable scope resolution and identifier equivalence. It retains the projection only for the canonical immutable parsed profile set. A replacement parsed set rebuilds it; mutable mutation working copies are not retained. Direct profile ids take precedence over aliases, and first-profile alias precedence is preserved. Unknown identifiers still resolve to themselves. The projection stores no credentials or authorization decisions.
- `packages/protocol/src/sessions/metadata/sessionDirectoryV1.ts`: absent/null directory markers return the existing `path` classification without constructing a Zod parse failure. Present markers still use the canonical stored-reader schema, including additive-field handling.
- `packages/protocol/src/sessions/metadata/terminalMetadata.ts`: absent/null terminal-serviceability evidence returns the existing null outcome before parsing. Present evidence still uses the same schema. Only this guard belongs to FX82b; the existing terminal schema-factory edits were preserved.
- `apps/ui/sources/sync/domains/session/awareness/sessionAwareness.ts`: ordinary Sessions without a workflow headline no longer parse `undefined` on every awareness projection. Present headlines remain schema-validated.

Each corresponding existing `.test.ts` file was strengthened. No new production files, styles, components, polling timers, limits, worker, shared decrypt cache, persisted format, wire shape or feature gate was added. Visible changes: none. No visual-design acceptance is claimed. Product documentation was not changed because the accepted data shapes, security outcomes and visible behavior remain the same.

The profile lookup's old linear decision path was replaced through its canonical owner rather than adding a consumer cache. Temporary working copies use the same classifier without retention. Protocol validators and the lenient base64 decoder remain intentional distinct contracts, not competing strict-admission owners. FX82's Session owner-envelope and DEK retention mechanisms were left intact; no consumer receives retained access authority.

## RED, GREEN and composed evidence

Sanitized evidence and reproducers are in `../qa-shots/FX82b/`.

| Contract | Observed RED | Observed GREEN |
| --- | --- | --- |
| Base64 ingress avoids full RegExp/substrings | `fx82b-base64-red.log`, original owner performs the observed operations | `fx82b-protocol-final.log`, strict vectors/padding/invalid alphabet and multi-megabyte round trips pass |
| Profile scopes project once per profile set | `fx82b-scope-red-final.log`, 40 repeated profile enumerations | `fx82b-ui-green.log`; strengthened values-and-entries count assertion also passes in `fx82b-scope-count-final.log` |
| Absent directory marker does not parse | `fx82b-directory-source-red.log`, removing this lane's guard yields 40 real parse calls | `fx82b-directory-source-green.log`, guard restored and source-owner tests pass |
| Absent workflow headline does not parse | `fx82b-awareness-red.log`, 20 real parse calls | `fx82b-ui-green.log`, all 15 awareness tests pass |
| Absent terminal evidence does not parse | `fx82b-terminal-red.log`, 40 real parse calls | `fx82b-protocol-final.log`, all 16 terminal tests pass |

Spies observe and delegate to real implementations; domain behavior is not replaced. The first directory test invocation used the package alias and therefore exercised existing dist. The final test imports its source owner directly; the separate guard-removal RED and restored GREEN above close that harness gap. An intermediate profile test incorrectly expected identity learning to replace an established Home identity. The broader suite rejected that expectation; the final test uses a genuine second profile and preserves identity-replacement refusal.

All source tests and typechecks were routed through `./apps/stack/bin/hstack-exec`, without `--local`. The user/orchestrator's standing 2026-10-10 remote-computation and workspace-transfer authorization was used. Selected source-test target: nl3, continuously moving canonical mirror with the launcher's synchronization barrier. Browser automation attached from the controller to the canonical remote QA-browser owner, as authorized separately. Ignored profiler inputs were compressed/transferred to the routed analyzer by `chains.cjs`; its failed initial oversized-argv attempt is not described as successful analysis.

Successful suite commands, with terminal output retained:

- Protocol source runner: `node node_modules/vitest/vitest.mjs run --config vitest.config.ts` with the three edited Protocol tests: **29 passed**, `fx82b-protocol-final.log`.
- UI source harness, from `apps/ui`: `node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts` with `serverProfiles.test.ts`, `serverProfiles.adoptionAuthority.test.ts`, and `sessionAwareness.test.ts`: **149 passed**, `fx82b-ui-green.log`.
- Same UI source harness with `hooks.sessionListRowProjection.test.tsx` and `sessionSnapshot.performance.test.ts`: **17 passed**, `fx82b-composed-green.log`. This executes real encryption, snapshot/store publication and row subscriptions. The existing 150-row/three-Home React test observes **171 total renders** for mount plus 21 target-row changes; unrelated rows remain at one render. Existing coverage made another overlapping render-count test unnecessary.
- Same UI harness with owner projection, snapshot DEK states, exact Session, stored-Session equality, list-change impact and list-renderable suites: **142 passed**, `fx82b-refusal-green.log`. These include keyless/mode-mismatch/recipient/missing-envelope and changed-envelope controls. The real owner-envelope composed regression also passed in the performance suite.
- Public Protocol `corepack yarn --cwd packages/protocol -s typecheck`: **exit 0**, `fx82b-protocol-typecheck.log`. The temporary directory guard sensitivity check was restored to these same production bytes and source GREEN reran.
- Final scoped `git diff --check`: **exit 0**.

Failed/unavailable package evidence is not waived. Public UI typecheck on windows1-linux refused its insufficient memory capacity (exit 1). The linux1 attempt remained in heavyweight admission and was cancelled through its own handle (exit 130). The subsequent nl3 public UI typecheck reached compilation and exited **2**; `fx82b-ui-typecheck-nl3.log` contains production/test errors in other paths, including `readSessionLayout1OwnerProjection.ts:55`, plugin UI projections, translations, theme and Voice, plus TS5083 missing temporary test-membership configs. This lane did not edit those errors or their owning hunks. A first UI test command waited on the dependency-refresh lock and was cancelled; a second ad-hoc command used the wrong config/cwd and failed before collection. The correctly rooted existing UI source harness produced the results above.

## What the loaded browser actually established

Canonical browser owner: `dev-targets browser start fx82b --stack=agent-qa-l12-b`, target **nl1**, owned remote PID **986481**, controller CDP **41297**. Agent-browser attached to that browser. The original QA origin and Account were retained; authentication used the prior QA helper's exact Account challenge flow without recording keys, tokens or decrypted content. No Stack, daemon or database lifecycle action occurred. The Expo bundle is a development bundle; React instrumentation costs are not estimates of production savings.

After an ordinary page navigation/reload, `loaded-basis.json` confirms the new base64 scan, identifier projection and directory guard in the loaded modules. `final-state.json` records the Account check and counts, not content. A source/module probe identifies UI behavior; it is not a claim that an old server/daemon identity identifies the UI bundle.

Duty uses Chromium `Performance` TaskDuration / Timestamp counters, not CPU sample counts. Heap values below are used JS heap, not retained/dominator sizes.

| Capture | Counter seconds | Task seconds | Duty | Heap before → after, bytes |
| --- | ---: | ---: | ---: | --- |
| Initial pre-change Home | 60.004 | 59.549 | 99.24% | 846,987,324 → 1,206,343,144 |
| Later pre-change rendered Home | 60.006 | 52.098 | 86.82% | 1,279,819,028 → 1,133,171,440 |
| Warm pre-change Home | 60.012 | 53.849 | 89.73% | 751,008,184 → 992,344,664 |
| First current-source interval after reload | 60.007 | 59.528 | 99.20% | 1,007,083,480 → 1,433,952,484 |
| Current-source rendered Home | 60.047 | 59.657 | 99.35% | 1,837,817,240 → 1,507,402,992 |
| Later current-source Home | 60.073 | 44.895 | 74.73% | 824,192,200 → 785,744,212 |

Each has a same-named `.metrics.json` and sanitized `.cpuprofile`: `idle-before`, `settled-before`, `warm-before`, `idle-after`, `warm-after`, `final-home`. The latter current-source captures include six heap samples. They rise and fall across GC; they do not establish a persistent leak or a memory-saving result. These are not controlled matched-corpus measurements: hydration and inventory reads remained active, Session counts grew, and the shared source/runtime moved. The first current-source interval starts before Home finished rendering. No “settled, no background work” invariant was proved.

Observed trigger/caller evidence:

- Prior profile caller chains (`fx82b-chains.log`) connect exact-Session applications to list, activity, composer and shell subscribers, and quota progress to usage repricing. `exact-session-triggers.json` reaches `hydrateRequiredSession → fetchSessionsOnce → applyPlannedChangeActions → runSocketReconnectCatchUpViaChanges`. This identifies reachable work, not a proof of an infinite reconnect loop. A subsequent 20-second reconnect probe saw no reconnect publication.
- `idle-timers.json`: 51 crypto-yield callbacks, 38 Session background-hydration yield callbacks and 19 hydration flush callbacks in 20 seconds. The observed timing trigger is real pending hydration/crypto work; it is not evidence to delete the yields or impose a new cutoff.
- `idle-network.json`: six control frames and two ephemeral frames in a later 20-second window. `exact-session-repeat-probe.json` separately records zero new exact-Session reads in its window. These observations refute treating every busy interval as the same exact-Session retry loop.
- The current short profile (`current-short.cpuprofile`, routed `fx82b-current-chains.log`) puts sampled JS self-time primarily under Curve25519/public-key validation reached through `Encryption.openDataKeyEnvelopes`. Schema hot paths were not established as the remaining dominant cause. CPU profile duration includes protocol scheduling outside its five-second counter interval; its self seconds must not be divided by that counter interval or summed with overlapping ancestry.
- `key-opens.json`: **2,916 actual envelope opens**, **1,972 distinct ciphertexts**, **944 repeated opens**, zero failed opens in 20 seconds. Ciphertexts and opened keys are never emitted; only counts/stacks are retained.
- Separate `key-batches.json`: nine Session DEK plans, 858 rows, **zero requested decrypts**, **572 cache hits**. Therefore Session DEK cache misses do not explain all the observed curve work. The two windows differ; their counts are not a join by identity.
- `key-callers.json`: **777 `decryptEncryptionKeys` calls / 2,274 items** in 20 seconds. Its largest grouped callers are Artifact list decrypts: two Action list batches totaling 1,000 items, plus a 500-item profile-catalog census through `loadAiLaunchProfileArtifacts → readCapturedProfileCatalogProjection → readWithMaintenance`. Artifact provenance and saved-secret materialization also open keys. `actionAccountContext.ts` deliberately owns a new invocation-local Artifact key map and captured encryption, so repeated independent censuses do not reuse another invocation's keys. No replacement cross-Action key cache was introduced.
- `catalog-triggers.json` later observed no new profile observe/refresh/invalidate/projection call during 20 seconds. Existing in-flight census work, independent Artifact Actions, and repeated invalidation must still be distinguished. The exact self-retriggering caller has **not** been isolated.

The guarded before Script Run used the prior FX82 real Run/confirmation/own-lint approval recipe and reached `project_command_step_failed`; `run-before.metrics.json`, profile and log retain the result. DOM click to observed terminal state is **80.966 s**; actual native execution is **4.063 s**. The full counter interval is 175.982 s / 69.58% duty because an initial coordinate click was intercepted by another layer before the actual DOM control activation; it is not a comparable Run throughput sample. Navigation also needed direct DOM activation after pointer clicks were covered. No overlay/style correction was made in this lane.

Automatic approval review rejected a redundant follow-up approval-control click after that operation was already terminal, stating the task lacked specific authorization for that external state change. The rejected click was not bypassed. A text approval request for one guarded after-lint Run and its approval remains unanswered; the after-Run sample was not attempted.

## Remaining scope and handoff

[blocked] UI package clearance needs the current owners to resolve the compiler errors and temporary membership/config failure, then rerun the public UI typecheck. In particular, the FX82 owner helper's generic Symbol omission error is in an explicitly excluded concurrent hunk.

[blocked] The requested idle-loop correction is incomplete. The next deciding investigation is at Artifact Action/profile-catalog demand and invocation lifetime: distinguish initial paged census from a repeated trigger, reproduce that trigger through its real reader/loader/Action wiring, and correct that owner. Current code intentionally discovers granted launch-profile Artifacts by paging the authorized Artifact list and uses invocation-local crypto custody. Skipping discovery or sharing another invocation's keys would change a security/product contract, not merely optimize a Session selector. This lane supplies the caller/count evidence, not a verified originating-cause verdict or an unproven cache workaround.

`needsWarmHydration` and repeated full shared-metadata projection remain unchanged. Measurement redirected the remaining saturated crypto investigation to Artifact reads; it does not prove these Session paths are free. Existing list render-count and composed crypto/store coverage now ran successfully, but that does not certify every visible list/shell computation. No arbitrary poll interval, hydration cap, freshness delay, error cache or security bypass was added to manufacture idle.

[blocked] Complete the after Script Run only after the outstanding exact approval is supplied. Before/after matched settled Home and Run measurements remain owed. Native/mobile/macOS/Windows live performance is unmeasured; those platform measurements are release evidence, not extra source mechanisms.

Self-attack changed the work: the directory test now consumes source and has a fresh guard-removal RED; profile count coverage observes both entries and values so an uncached index rebuild cannot pass by changing enumeration APIs; the identity-change fixture preserves the established refusal; unchanged saturation and the Artifact callers reject the hypothesis that these hot-owner changes alone complete FX82b. Retained risk is the unresolved trigger, unmatched changing corpus, unexecuted after-Run and failed UI package gate.

Cleanup observed: all temporary browser observers restored their originals in `finally`; the later full page reload also removed earlier instrumentation. Agent-browser closed exit 0, and the TTY browser owner terminated after SIGINT (exit 1). Canonical exact-target nl1 verification exited 0 with owned PID 986481 absent and the exact temporary browser profile absent. Controller CDP 41297 is unreachable (`curl` exit 7). No lane-owned Stack or Service process was started or stopped, and no Git mutation occurred.

RELOAD NEEDED: apps/ui/sources/sync/domains/server/serverProfiles.ts; apps/ui/sources/sync/domains/session/awareness/sessionAwareness.ts; packages/protocol/src/crypto/base64.ts; packages/protocol/src/sessions/metadata/sessionDirectoryV1.ts; packages/protocol/src/sessions/metadata/terminalMetadata.ts. Browser-page reload/probes were performed only; any Stack reload remains orchestrator-owned.
STATUS: BLOCKED
