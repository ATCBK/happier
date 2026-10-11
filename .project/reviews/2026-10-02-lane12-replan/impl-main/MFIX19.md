# MFIX19 — machine heartbeat subscription locality

## Outcome

Implemented the systemic machine-store correction. Online heartbeat updates now publish `activeAt`/`updatedAt` through dedicated active-Home and server-scoped presence maps while retaining the identity of `machines`, `machineDisplayById`, `machineListByServerId`, their records, and their arrays. Semantic Machine changes, including online/offline `active` transitions, replacement, metadata, daemon state, access, availability, and removal, still replace the appropriate projection.

There is no visual or interaction change. Presence dots, last-seen/reachability projections, launch selection, and CLI-currentness selectors still re-evaluate from fresh in-place presence values when the narrow presence map publishes; unchanged derived presence results retain identity. The `happier-ui-craft` effect is therefore limited to preserving truthful presence and eliminating heartbeat-driven work, with no restyling.

## Subscriber and writer inventory

The production subscriber inventory covered every `state.machines`, `machineDisplayById`, and `machineListByServerId` selector plus the inventory/presence owners found by symbol and domain searches.

- Semantic machine selectors: `useMachineDisplayById`, `useMachineDisplayNamesById`, `useAllMachines`, `useMachineRecordValues`, `useMachineRecordListsByServerId`, `useMachineListByServerId`, `useMachineListForServer`, `useMachine`, and `useServerScopedMachine` in `sync/store/hooks.ts`; board membership and daemon-media metadata selectors; session/workspace target projections; and machine inventory snapshots. These now see stable maps/records for timestamp-only heartbeats.
- Presence/reachability selectors: `useMachinePresenceCounts`, `useLaunchSelectionMachines`, `useMachineCliDetectionTarget(s)`, `useMachinePresenceSummary`, `machineReachability.ts`, board deadline reads, machine widgets/details, New Session and placement selectors. The store still emits one presence-slice update with fresh values; selectors publish only when online/offline, last-seen, reachability, or their own semantic projection changes.
- Non-subscribing imperative reads in Actions, RPC targeting, transfers, SCM, voice, and daemon operations use `getState()` and continue to observe the newest heartbeat values on the retained records without creating React fanout.
- Writers: active-Home and server-scoped `applyMachines`, warm display replacement, concurrent Home refresh, concurrent Home retirement, and Account reset were inspected. Concurrent Home refresh now delegates inventory publication to `applyMachines`; Home/Account retirement clears the matching presence projection. Warm display replacement remains a bootstrap-only display writer and is not a heartbeat publisher.

The three earlier consumer fixes remain intentionally retained: the usage key still filters semantic changes the usage query does not consume; session-list impact still avoids scans for display changes that cannot affect grouping; plugin execution-origin eligibility mode still ignores presentation-only semantic changes. None is now a competing heartbeat owner.

## TDD and validation

- RED: the real machine-domain test showed a timestamp-only heartbeat replacing all three semantic projections (`expected Object.is identity`, received new map with `activeAt: 2`).
- GREEN: the owner test proves stable active/scoped maps, records, display records, and arrays while both presence maps advance. The render-count test proves `useAllMachines` and `useLaunchSelectionMachines` do not rerender for a still-online heartbeat while their retained records expose the fresh timestamp.
- PASS: owner/render/reachability batch — 4 files, 30 tests.
- PASS: usage, session-list impact, plugin execution-origin, inventory snapshot, and encrypted/plain machine-sync batch — 6 files, 44 tests.
- FAILED before Vitest: one automatically placed adjacent batch selected `mac3-linux`, whose dependency refresh could not stop its verified Expo process (`HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED`). The same source suites then passed locally through the wrapper.
- FAILED unrelated moving-tree package gate: UI `typecheck` emitted the existing broad `TS6307` project-file-list failures across desktop activity, voice, and other concurrent source; no displayed diagnostic referenced an MFIX19 file. This gate is not claimed passed.
- FAILED unrelated moving-tree harness: `concurrentSessionCache.supervisedSocket.test.ts` failed all cases before reaching the selected scenario because its `serverProfiles` mock lacks the newly required `readServerProfileHomeName` export. The writer-path source was inspected, but this adjacent suite is not claimed passed.

## Adversarial closeout

Alternative cause: consumer-local expensive work is no longer needed to explain the invalidation because the RED directly observed the store replacing every semantic projection on a timestamp-only update. Neighboring cases cover incremental/full inventories, active/other Homes, removals, changed rows, stale warm displays, online/offline transition behavior, and encrypted/plain hydration. The split-brain attack found the concurrent Home writer and routed successful refresh publication through the same owner; reset/retirement now removes presence state with semantic state.

Subtraction result: the two presence maps are the minimum new state needed to notify presence readers without changing semantic map identity. No cache, timer, feature gate, parallel reachability decision, or consumer-owned heartbeat filter was added. The owner mutates only the two retained timestamp fields before publishing the immutable presence snapshot; semantic equality still includes `active` and every non-heartbeat field.

## Live follow-up

NEEDS-MAIN: restart/rebuild the Main source export, verify the loaded identity contains the MFIX19 commit, then repeat warmed 8 s Home, Projects, and Action-detail CPU profiles. Compare renderer task/script time and confirm the usage digest, session-list scan, and plugin-origin stacks do not recur. No Main restart was performed in this lane.

Residual risk: the post-change idle-CPU delta remains live-unmeasured until Main reloads. The moving-tree typecheck and concurrent-cache harness remain red for the unrelated failures above; the focused owner and affected projection suites are green.

STATUS: DONE
