# MQA2 — functional and edge-case QA

## Outcome

The loaded `agent-qa-l12-main` source snapshot is not fit for the requested integrated Action-parity journey. The UI and daemon were healthy and their selected/loaded identities matched, but New Session reproduced a global crash in source bytes loaded before current fix `2611fb93a9`; the Account's retained Projects pointed at unreachable NLDW daemon instances; Settings → Actions hung the browser target; and a widget add remained indefinitely pending with no effect. The current-source profile-compatibility regression test is green, but the shared stack could not be restarted while MV3 was using it, so no current-source live replay was possible.

### Runtime basis

- Observed before QA: `runtime.health.status=healthy`; HTTP `200` at `http://happier-agent-qa-l12-main.localhost:3019`.
- Observed identities: server `045ea5d769710cca` selected=loaded; daemon `398d71d86ee9f1a1` selected=loaded; server/UI local, daemon `nl1`, source export.
- Observed stack start: `2026-10-11T00:23:47Z`; current fix `2611fb93a9` committed at `2026-10-11 02:59:53 +0200`, after that snapshot was built.
- Browser cleanup: both lane-owned `mqa2` browser lifetimes were terminated with SIGINT; the shared stack was left running.

## Scenarios

| Scenario | Steps | Expected | Observed | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- | --- |
| 1. New Session | Restored the authorized Account key via stdin; opened New Session; entered a valid prompt; inspected selected Claude/Haiku target; attempted a fresh draft. | Built-in Agents remain selectable without ACP configuration; valid prompt enables Send; empty prompt is visibly disabled; zero-machine state is truthful. | Retained draft showed `Online` and `Claude · Couldn’t check this machine`; valid text left `Start New Session` disabled. `Start another` reached the global error boundary with `ZodError: Invalid V2 backend target key`. The Account had 8–11 online machines, so the literal zero-machine branch was not reachable without corrupting shared state. Current source contains the owner correction and its focused tests pass, but loaded bytes predate it. | `.happier/design-lab/lane12-final/live/mqa2-new-session.png`; `.happier/design-lab/lane12-final/live/mqa2-new-session-crash.png` | **FAIL / loaded-snapshot blocker** | `2611fb93a9` (current source; live replay pending stack reload) |
| 2. Action parity | Attempted to establish the in-app Agent session; then navigated directly to Settings → Actions to inspect/reset policy. | UI and Agent perform matching setting/reset, tab/layout, script/output, operation-list and memory flows; danger denial has no effect; approval has exactly one effect; disconnected clients refuse truthfully. | Agent path was blocked by Scenario 1. Direct navigation reached `/settings/actions` and then left the Chromium target unresponsive to both agent-browser and an independent Playwright CDP attach; only terminating the lane browser recovered automation. No action was approved, so no unintended effect occurred. | `.happier/design-lab/lane12-final/live/mqa2-new-session-crash.png` (upstream Agent blocker; Settings hang could not capture because the target stopped responding) | **BLOCKED / FAIL** | None identified from live evidence; requires current-source reload and exact replay |
| 3. Service Move | Opened existing Projects and their Local services/Files surfaces; attempted to reach a service placement control and an in-app Agent. | Exact-machine and Auto/pool reviews name the target; approval performs one stop/start; changed target refuses; `action.spec.search` discovers the Action. | Existing `qaf2-dnd-project` and `happier-dev` checkouts were bound to retained NLDW machine instances that the UI reported unreachable. The service surface could not load, and the Agent path was blocked by Scenario 1. No move was issued. | `.happier/design-lab/lane12-final/live/mqa2-tree-unreachable.png` | **BLOCKED** | None |
| 4. Secret approval and plugin diagnostics | Restored the Account securely; inspected authenticated Home/plugin loading while attempting to establish an Agent session. | Live-only secret approval never persists/discloses material; plugin-collection diagnostics are truthful. | The prerequisite Agent invocation could not start. Console repeatedly reported `plugin_cleanup_failed:happier.triage`, but no secret was entered beyond the recovery-key restore field and no secret Action was issued. This is insufficient to pass or fail secret custody. | `.happier/design-lab/lane12-final/live/mqa2-new-session-crash.png` | **BLOCKED** | None |
| 5. Widgets | Opened `qaf2-dnd-project`; collapsed and expanded the About widget; opened group options; selected `qaf3 no-input fixture` and invoked Add. | UI and Agent can add/remove/rearrange widgets and groups through the canonical widget Actions; local disclosure remains local. | Collapse/expand passed and retained the surrounding group. Group controls rendered. Add remained `Loading… Add to qaf2-dnd-project` for more than six seconds, produced no new widget, and remained pending after modal close. Agent parity was blocked by Scenario 1; destructive removal of shared pre-existing groups was not attempted. | `.happier/design-lab/lane12-final/live/mqa2-widgets-collapse.png`; `.happier/design-lab/lane12-final/live/mqa2-widgets-add-stuck.png` | **PARTIAL: disclosure PASS; add FAIL; Agent BLOCKED** | None |
| 6. Tree rows | Selected Projects by pointer and keyboard; opened `happier-dev`; opened the Files/SCM pane; waited for rows. | File/SCM trees support expansion, collapse, keyboard focus, long names and selection. | Project-row selection worked. The file tree never materialized: `Couldn’t list files on NLDW4-5-40-40` / daemon unreachable; SCM history and Local Changes were unavailable. Therefore file-row expansion, long-name rendering and SCM keyboard behavior were not exercised. | `.happier/design-lab/lane12-final/live/mqa2-tree-unreachable.png`; `.happier/design-lab/lane12-final/live/mqa2-tree-project.png` | **BLOCKED** | None |
| 7. File read/write/Open through Actions | Confirmed `M14.md` ends `STATUS: DONE`; opened the real Project Files surface and attempted to establish Agent parity. | UI and Agent read/write/Open the same file through admitted Actions with truthful failure behavior. | UI refused truthfully because the selected checkout daemon was unreachable; no read or write occurred. Agent path was blocked by Scenario 1, so Action parity and Open could not run. | `.happier/design-lab/lane12-final/live/mqa2-tree-unreachable.png` | **BLOCKED** | None |

## Validation

- PASS: `./apps/stack/bin/hstack-exec --target=nl1 -- yarn workspace @happier-dev/app exec vitest run --config vitest.config.ts sources/sync/domains/profiles/profileCompatibility.test.ts` — 1 file, 4 tests.
- FAILED setup attempts (reported, not counted as tests): two ad hoc Vitest invocations from repository root could not resolve the UI `@/` alias; rerunning through the UI workspace was the valid focused lane above.
- Not run: package typecheck/build (MGATE3 owner); current-source live replay (shared stack reload prohibited while MV3 runs); Agent/MCP/CLI Action journey (New Session blocker); zero-machine state (retained Account had online machines).

## Adversarial closeout and residual risk

- Alternative cause checked: stack health and HTTP delivery remained green, so the New Session failure was not caused by a stopped stack. The exact exception matches the compatibility owner corrected after the snapshot was built, and current focused tests pass.
- Neighboring cases checked: a fresh browser reproduced normal authenticated navigation, then exposed independent retained-machine reachability and widget-settlement failures.
- Blast radius: all Agent-driven scenarios depend on New Session; file/SCM/service scenarios depend on a reachable checkout Machine; neither can be inferred from registration or source tests.
- Environment gap: a deliberate reload of `agent-qa-l12-main` after MV3 finishes is required before replaying all seven scenarios. The widget pending settlement and Settings → Actions hang must be replayed first because they may be stale-snapshot symptoms rather than current-source defects.

STATUS: DONE

## Round 7 evidence

### Outcome

Round 7 reached the supplied 23:55 export on `NLDW6-3-11-20 · 44bd`, restored the Account key through stdin without disclosure, and proved that `da96df4c7b` removed the previous session-list scan without clearing the app-wide idle CPU failure. A fresh CPU profile identified the next heartbeat-driven owner: every machine refresh rerendered each renderless app-shell plugin execution-origin selector, rebuilding all-Home inventory snapshots and serializing eligibility even when only presentation timestamps changed. I fixed that canonical Administration selector path test-first and committed `36094949f4` (`perf(ui): suppress plugin origin heartbeat renders`). The no-restart export predates this commit, became non-responsive again, and therefore cannot provide post-fix live numbers or trustworthy interaction evidence for the remaining matrix.

### Runtime and performance evidence

- UI: `http://happier-agent-qa-l12-main.localhost:3023`; health `healthy`; server selected=loaded `4bac746c21e7be57`, daemon selected=loaded `4ad71e754fc58c51`; source-snapshot export; stack was never restarted or stopped.
- Browser owner: label `mqa7`, CDP browser on `nl1`; Account recovery key was streamed from `.happier/qa/unified-work-live/state/dev-test-account.key` into the recovery field only and never printed.
- Warmed 8 s Home: task `+7.937003 s`, script `+4.216153 s`, heap `+191,834,024 B` (Round-6 task baseline `+7.977132 s`).
- Warmed 8 s Projects: task `+6.018304 s`, script `+1.993470 s`, heap `-171,480,184 B` (Round-6 baseline `+8.055509 s`; negative heap delta reflects collection, not a leak).
- Warmed 8 s Action detail: task `+7.291532 s`, script `+2.339069 s`, longest task `987 ms`, heap `+107,737,964 B`, 32 long tasks. Screenshots: `.happier/design-lab/lane12-final/live/mqa2-r7-projects.png`, `mqa2-r7-actions-loading.png`, and `mqa2-r7-action-detail.png`.
- A 6 s CPU profile sampled `serializePluginMachineExecutionOriginMachineFacts` and `resolveAllProfileMachineInventorySnapshots` beneath `usePluginMachineExecutionOriginSelection`; a second 4 s profile reproduced that exact stack beneath the app-shell renderless selector. The former Round-6 `resolveMachineSessionListIndexImpact` path was not the sampled owner.

### Scenario replay

| Scenario | Observed current-source result | Verdict |
| --- | --- | --- |
| MFIX17 warmed idle CPU | Home and Action detail still consumed almost their complete 8 s windows. The owner-level render fanout was reproduced and fixed in source; renderless app-shell selectors now subscribe to stable eligibility facts, while picker/detail consumers retain live machine presentation and invocation-time reads. The no-restart export could not provide post-fix numbers. | **FAIL on loaded export; source fix GREEN; live recheck BLOCKED** |
| MFIX18 native approval and session continuity | After profiling, returning Home produced `Can't reach This Home`, then the loaded renderer stopped answering accessibility snapshots and direct screenshot capture. No new Claude turn or native approval was issued; turn 2 and stop/resume remain unverified. | **BLOCKED by loaded-export renderer failure** |
| Terminal, Git fixture, and Services Move | The terminal, Git/service declaration, Local services empty/new-service states, exact and Auto/pool reviews, stop/start effects, changed-target refusal, and `action.spec.search` all require the non-responsive renderer. No terminal or service mutation was issued. | **BLOCKED by loaded-export renderer failure** |
| Agent Actions matrix, dangerous approval, secret, and fresh summary | No working post-baseline Agent turn was reachable. No Action effect, approval decision, or secret entry occurred, so denial/approval cardinality, live-only custody, and the fresh one-sentence approval summary remain unverified. | **BLOCKED by Agent/session prerequisite** |
| Offline-machine truthfulness and 44bd default controller | Before saturation the shell reported 17 online and 72 offline Machines, but settled details for `33fc`, `7b41`, and `4633` and a fresh Create default could not be reached. Counts were not treated as detail-state or default-selection evidence. | **BLOCKED / not inferred from shell counts** |
| MV6C 390 px armed Continue | No qualifying armed Session could be established, so the chip-rail overlap check was not reachable. | **BLOCKED by Agent/session prerequisite** |

### Fix, validation, and closeout

- RED: the real Account/machine-owner hook rendered twice when only `activeAt`, `updatedAt`, and display metadata changed, failing `expected 2 to be 1`. GREEN: the renderless selection mode stayed at one render while eligibility transitions (locked, revoked, replaced, offline, stale, missing) still updated and invocation-time resolution read the fresh Machine.
- GREEN: focused owner test — 1 file, 4 tests. Adjacent owner batch — `pluginExecutionOrigin`, `machineInventorySnapshots`, and both selection suites: 4 files, 35 tests.
- Commit `36094949f43760b5baa1f620363de37ea5b779cd` was assembled with a private index, explicit path closure, verified current Git identity, and `Co-authored-by: Claude Opus 5.5 <noreply@anthropic.com>`; the shared index was realigned and unrelated AppShell work remains unstaged.
- Split-brain audit: Administration remains the sole origin-selection and inventory-projection owner. The app-shell consumer selects the same owner in eligibility-only mode; visible picker/detail consumers retain the existing presentation mode, and fresh execution still re-reads the canonical raw store. No parallel heartbeat filter or second availability decision was added.
- Visual review under `happier-ui-craft`: the reachable Projects and Actions pages showed no new layout defect. The remaining failure was functional saturation, so no visual source was changed.
- Adversarial check: the previous session-list cause is disfavored because the new profiles sampled a different named stack after `da96df4c7b`. A source GREEN cannot establish loaded-browser improvement, and the browser's `Can't reach This Home` state may be a downstream symptom rather than the CPU cause; both require Main's next export/replay. No package typecheck/build ran because MGATE3 owns it.
- Cleanup exception: the execution safety layer rejected the requested Ctrl-C for browser handle `95392`; the lane-owned `mqa7` browser may therefore remain running. No alternate termination path was attempted, and the stack remains running as required.
- Residual risk: post-`36094949f4` idle measurements and the full approval, session, terminal, service, Action, offline-detail, and 390 px matrix remain live-unverified. The next evidence boundary is a Main-owned export containing `36094949f4`, followed first by the same three warmed 8 s measurements.

STATUS: DONE

## Round 2

### Outcome

Current-source replay confirms two real loaded-runtime defects: Settings → Actions makes its Chromium renderer effectively unusable under sustained CPU work, and adding `qaf3 no-input fixture` to a fresh nl1-backed Project remains indefinitely pending with no visible layout effect. The stale NLDW Project blocker was removed by creating `/home/happier/mqa2-r2-project` on the stack-owned daemon Machine `883d0ae4-974f-4820-a1bf-6b2fc0627204`; the two failures therefore are not inherited-checkout artifacts. No source fix was attempted because both canonical corridors contain extensive concurrent uncommitted work, and the runtime evidence did not yet prove a safe owner-level correction.

### Runtime basis

- Observed: HTTP `200` at `http://happier-agent-qa-l12-main.localhost:3019`; no stack restart was performed. Stack metadata initially said degraded and later healthy, exactly as the Round-2 warning anticipated; HTTP governed admission.
- Observed: stack daemon status was healthy on nl1, runtime identity `0cf76aec0d5f26e0` selected=loaded, Machine id `883d0ae4-974f-4820-a1bf-6b2fc0627204`. The fresh Project flow selected the matching `NLDW4-5-40-40 · 883d` online Linux row and opened `/home/happier/mqa2-r2-project`.
- Observed: the authenticated lane browser remained owned by session `mqa2`; the stack was never restarted or stopped.

### Scenario replay

| Scenario | Steps | Expected | Observed | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- | --- |
| Settings → Actions suspected hang | From authenticated Home, opened Settings, then instrumented the Actions route with Long Task and Chrome Performance metrics for eight seconds. | Route remains responsive and configurable. | Renderer task time rose from 0.62s to 13.75s over the observation; script time rose from 0.22s to 10.74s; heap grew about 49 MiB. The trace contained an 8.84s long task plus repeated 0.6–2.2s stalls, only 24 DOM mutations, and 40 animation frames with a 2.17s maximum gap. Screenshot and later snapshots timed out; the target never recovered. This is CPU-bound render/computation, not a network-loading spinner. Profiling could not complete while the renderer was saturated, so the exact hot function remains unproven. | None: screenshot itself timed out after fonts loaded. | **FAIL — current-source production defect** | None |
| Fresh Project prerequisite | In Projects → Add project → A folder on a machine, chose online Machine `…883d`, created `mqa2-r2-project` under `/home/happier`, verified the review showed `/home/happier/mqa2-r2-project`, then opened it. | A Project on the stack-owned reachable nl1 daemon is usable for Round-2 QA. | Project appeared as `mqa2-r2-project`, checkout `~/mqa2-r2-project`, and loaded Overview/Code/Git/Files/Local services surfaces without the old daemon-unreachable refusal. | `.happier/design-lab/lane12-final/live/mqa2-r2-new-session.png` (same authenticated current-source browser; Project screenshot was not captured) | **PASS** | N/A |
| 5. Widgets suspected Add failure | In the fresh Project Overview side-area Add surface, selected the exact `qaf3 no-input fixture` and pressed `Add to mqa2-r2-project`; waited ten seconds and inspected console/state. | One widget is added and the action settles, or a truthful pending/refused outcome appears. | Button stayed disabled as `Loading... Add to mqa2-r2-project`; popover stayed open; no widget appeared. Console showed artifact refresh activity but no surfaced refusal/error, so it is unsafe to infer whether the effect was never issued, an approval/result was lost, or the write applied without UI settlement. | Screenshot capture to the required path did not complete; the browser's temporary capture is not treated as a durable artifact. | **FAIL — current-source production defect** | None |
| 1. New Session | Opened a fresh ordinary draft on current source; inspected built-in Agent/model and submit state; entered a valid no-tool prompt. | Built-in Agent is selectable without ACP; valid prompt enables Send; no invalid-target crash. | The former global `Invalid V2 backend target key` crash did not recur, and Claude/Sonnet rendered. However the selected retained Machine showed `Claude · Couldn't check this machine`, folder selection was disabled, and the valid prompt did not yield an enabled `Start New Session`; no Agent turn was issued. | `.happier/design-lab/lane12-final/live/mqa2-r2-new-session.png` | **PARTIAL: crash fixed; create admission still FAIL** | `2611fb93a9` closes only the prior crash |
| 2. Action parity | Attempted to establish the Agent prerequisite after the New Session replay. | UI and Agent complete the settings/layout/script/output/ops/memory parity matrix with exact approval outcomes. | No Agent session could be admitted from the retained Machine state. Direct Settings → Actions independently failed as above. No dangerous effect was approved, so denial/one-effect/unknown-client claims remain unverified. | `.happier/design-lab/lane12-final/live/mqa2-r2-new-session.png` | **BLOCKED by current New Session and Actions defects** | None |
| 3. Service Move | Created the required fresh reachable Project and opened its Local services entry point. | Exact/Auto placement review, mismatch refusal, stop/start, and `action.spec.search` discovery pass through UI and Agent. | The empty fresh folder had no service to relocate, and the Agent prerequisite was unavailable. No move or approval was issued. | None | **BLOCKED: no service fixture + Agent unavailable** | None |
| 4. Secret approval / plugin diagnostics | Monitored the authenticated current-source console across Home and fresh-Project flows; did not enter any secret except the recovery key in its dedicated restore field. | Secret approval is live-only; plugin diagnostics settle truthfully. | Secret Action could not be started without an Agent. `[PluginUiExecutableModuleHost] plugin_cleanup_failed:happier.triage` repeated on current source; no evidence ties it to the Settings or Widget failures. The required append to `../HANDOFF-OTHER-PROGRAMS.md` was attempted separately and rejected by the sandbox approval boundary as outside the authorized report file, so the evidence remains recorded here for Main to route. | `.happier/design-lab/lane12-final/live/mqa2-r2-new-session.png` | **Plugin diagnostic FAIL / secret flow BLOCKED / routing BLOCKED** | None |
| 6. Tree rows | Opened Code/Files surfaces in the fresh Project; observed Project/All files mode and reachable checkout. | Expansion/collapse, keyboard focus, long-name selection, and SCM rows work. | The Project folder was intentionally empty, so the tree exposed no material row corpus. This establishes reachability only; keyboard/long-name/SCM behavior was not exercised. | None | **PARTIAL: reachability PASS; row matrix unrun** | None |
| 7. File read/write/Open | Confirmed the fresh Project checkout and Files surface. | UI and Agent read/write/Open the same file through admitted Actions. | No file fixture was created before browser saturation, and the Agent path remained unavailable; no read/write/Open effect was issued. | None | **BLOCKED** | None |

### Validation and adversarial closeout

- No source tests or typechecks were run: no source change landed, and MGATE3 owns the package gates.
- Alternative-cause check: HTTP remained 200 and a separate fresh tab/project worked while the Actions target was unresponsive, falsifying a stopped-stack explanation. The fresh nl1 Project falsifies the retired-NLDW explanation for Widget Add.
- Neighboring-case check: the widget failure was replayed with the exact round-1 fixture on a new Project rather than a retained shared layout. New Session no longer crashes, but valid-submit admission still fails on its retained Machine selection.
- Hypothesis lock: the Actions measurements prove renderer saturation but not the hot function; the widget observations prove missing UI settlement but not whether the backend effect was unissued, pending approval, or applied. Both are reported at that evidence level.
- Residual risk: service relocation, Agent parity, secret custody, tree interaction, and file Actions remain unverified. The cross-program handoff append and final browser-owner Ctrl-C were both rejected by the sandbox approval boundary; the diagnostic is preserved above and the lane-owned browser remains running. No stack process was restarted or stopped.

STATUS: DONE

## Round 3

### Outcome

Round 3 did not reach the requested Agent/fixture matrix. HTTP admission passed and the Actions catalog was initially usable, but its detail interaction still consumed sustained main-thread time and the first browser eventually required replacement after automation became unresponsive. More decisively, the requested nl1 fixture Machine `883d` was visibly offline and the stack metadata reported its daemon `down`/`starting`; selecting online Machine `8dab` did not provide a workaround because the product returned `Unable to load folder · Happier can’t reach the daemon on this machine`. Per the Round-3 instruction, the stack was never restarted. The connected Claude profile could be selected, but a valid Haiku prompt still left `Start New Session` disabled with `Claude · Couldn’t check this machine`, so every Agent-driven scenario remained blocked.

### Runtime basis

- Observed: HTTP `200` at the new URL `http://happier-agent-qa-l12-main.localhost:3011`; no stack restart or stop was performed.
- Supplied by Main: loaded source includes MFIX4 `e90c843ace`, MFIX5 `84ed7eea57`, and MV4 `69c84cf4b8`. Observed stack metadata exposed matching selected/loaded server identity `179f1c3259d9242d`, but did not expose those commit ids directly.
- Observed in `stack info`: server/UI running, daemon remote target `nl1`, daemon status `starting`, `runtime.health.status=degraded`, issue `daemon_down`. This metadata was not used to restart the stack; the UI independently showed Machine `883d` offline and produced a daemon-unreachable folder refusal.
- Observed in the authenticated UI: six Machine identities were online, while `883d` was disabled as offline. Online identity `8dab` could be selected, but browsing `/home` failed with the daemon-unreachable refusal, so it was not treated as a valid substitute for the requested fixture Machine.
- Browser cleanup: the first lane-owned `mqa3` browser was terminated after automation became unresponsive; a replacement `mqa3` browser was started for the remaining probes and terminated with Ctrl-C at closeout. The shared stack was left running.

### Actions performance replay

- Catalog transition, eight seconds: Chrome `TaskDuration` `0.002003s` → `1.145930s` (delta `1.143927s`), `ScriptDuration` `0.000144s` → `1.038766s` (delta `1.038622s`), JS heap `261,245,156` → `306,712,704` bytes (delta `45,467,548` bytes). The buffered observer contained 105 long-task records with a longest record of `1.264s`; because it was buffered, the record count is not attributed solely to the catalog transition.
- Detail policy toggle, eight seconds: opened `browser.context.annotation.attachComment`, changed the non-dangerous in-app policy from `Default` to `Allowed`, verified it selected, then restored `Default` and verified the reset. `TaskDuration` `0.000948s` → `4.987517s` (delta `4.986569s`), `ScriptDuration` `0` → `1.764228s`, JS heap `333,026,364` → `409,501,684` bytes (delta `76,475,320` bytes); 15 unbuffered long tasks, longest `0.744s`.
- Hot-function probe: an 11.438-second CDP CPU profile on the detail page was dominated by native `(idle)` `6.735s`, native `(program)` `4.175s`, and GC `0.516s`; no named JavaScript frame exceeded `1ms`. Therefore the live evidence proves sustained browser work but does not identify a source-level hot function. After the interaction, an `agent-browser get url` probe timed out at 12 seconds even after the stuck helper process was terminated; the browser owner had to be replaced. This is reported as an Actions/browser responsiveness failure, not a proven JavaScript root cause.

### Scenario replay

| Scenario | Steps | Expected | Observed | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- | --- |
| 1. New Session | Opened a clean draft; selected online Machine `8dab`; selected connected `Claude subscription · ai1@happier.dev`; retained Haiku 4.5; entered a valid no-tool prompt. | Connected profile clears native-sign-in admission; Start enables and the Agent replies. | The profile selection persisted as `Runs through Claude subscription: ai1@happier.dev`, but the surface still said `Claude · Couldn’t check this machine` and `Start New Session` remained disabled. Requested Machine `883d` was offline. No Agent session started. | None — authenticated screenshot persistence was denied by the sandbox, so evidence is recorded here. | **FAIL / daemon-dependent admission blocker** | None |
| 2. Action parity | Replayed Settings → Actions, opened a detail, changed and reset one policy; attempted the prerequisite Agent session. | UI and Agent perform settings/reset, tab/layout, script/output, ops and memory flows; dangerous deny has no effect, approval has exactly one effect, disconnected clients refuse truthfully. | UI policy change/reset passed. Catalog/detail performance remained materially hot and automation later became unresponsive. The Agent could not start, and Project scripts/output/ops/memory were unreachable without a daemon, so dangerous approval and unknown-client parity were not issued. | None — persistence denied. | **PARTIAL: UI policy PASS; responsiveness FAIL; Agent matrix BLOCKED** | None |
| 3. Service Move | Opened `mqa2-r2-project` and Local services; attempted to add/browse the requested nl1 fixture through the product. | Create a trivial long-running service, review exact and Auto/pool targets, approve one stop/start, refuse changed-target review, discover with `action.spec.search`; replay via Agent. | The Project checkout was retained but unreachable. Requested Machine `883d` was offline; online `8dab` returned the daemon-unreachable folder error. No service fixture, review, approval, move, or Agent search could be issued. | None — persistence denied. | **BLOCKED: no reachable daemon fixture** | None |
| 4. Live-only secret approval / plugin diagnostics | Selected the connected Claude profile and monitored the authenticated console; did not enter any secret beyond the recovery-key restore field. | Secret approval remains live-only; plugin diagnostics settle truthfully. | No Agent invocation could start, so secret custody was not exercised. `plugin_cleanup_failed:happier.triage` did not recur in this fresh browser. Console did show stale-server-generation notices and repeated machine-list hydration logs, but neither establishes a plugin-collection defect. | None — persistence denied. | **Secret BLOCKED; prior plugin error not reproduced** | None |
| 5. Widgets | Opened `mqa2-r2-project` Overview and inspected the widget Add control after MFIX5. | Add/remove/rearrange a widget and group in UI and via Agent; every write settles exactly once. | `Add a widget to mqa2-r2-project` was disabled because its checkout Machine was unavailable. The earlier indefinitely-pending Add did not recur because no write could be admitted; MFIX5 settlement therefore remains unverified live. | None — persistence denied. | **BLOCKED: checkout daemon unavailable** | `84ed7eea57` supplied as candidate fix; not live-verified |
| 6. Tree rows | Attempted to add `/home/happier/mv3-project`; opened the retained Project Files surface. | Expand/collapse, keyboard, long-name selection and SCM rows work on the mv3 fixture. | `883d` was absent from the enabled Machine picker. On `8dab`, `/home` browsing returned the explicit daemon-unreachable refusal. The retained Files surface rendered `Retry` without rows, so no tree/SCM interaction was possible. | None — persistence denied. | **BLOCKED: fixture Machine unavailable** | None |
| 7. File read/write/Open Actions | Opened the Project Files surface and attempted the Agent prerequisite. | UI and Agent read/write/Open the same file through admitted Actions. | No file rows loaded and no Agent could start. No read, write or Open effect was issued. | None — persistence denied. | **BLOCKED: daemon and Agent unavailable** | None |

### For Main to route

1. **Actions owner / MFIX4 follow-up:** catalog virtualization improved the immediate route transition versus Round 2, but the detail policy interaction still accumulated `4.986569s` of task time in eight seconds, 15 long tasks (max `744ms`), `+76,475,320` heap bytes, and the first automation target later stopped answering. The sampled profile attributes the hot interval to native `(program)` rather than a named source function; reproduce with a tracing profile around the toggle/route lifecycle rather than assuming a React function.
2. **QA stack owner:** HTTP is healthy, but the Round-3 prerequisite daemon is not. Machine `883d` is offline, stack metadata says `daemon_down`/`starting`, and an online sibling identity truthfully refuses folder access. The stack must be made reachable by its owner without asking this lane to restart it, then scenarios 1–7 need replay.
3. **MFIX5 live gate:** neither retained-Machine recovery nor widget-write settlement was exercised. The former visibly failed for `883d`; the latter was blocked before write admission. Do not treat the candidate commit as live-verified from this round.

### Validation and adversarial closeout

- No source changes, commits, tests, typechecks, or builds were made/run. This was live QA only; MGATE3 retains package validation ownership.
- Alternative cause checked: HTTP remained `200` and authenticated server-backed navigation worked, so neither the Actions behavior nor Project refusal is explained by a stopped HTTP stack. Conversely, daemon reachability is independently falsified by both the offline `883d` row and the explicit folder refusal; it is not inferred from stale stack metadata alone.
- Neighboring case checked: selecting online `8dab` did not recover folder access, while server-backed Settings and Projects navigation remained usable. Connected-profile selection persisted but could not compensate for Machine capability/reachability failure.
- Hypothesis lock: the Actions numbers establish expensive browser work and later automation failure, not the exact source owner; the CPU profile was inconclusive at source-function granularity. The New Session failure is reported as daemon-dependent because the same surface explicitly said it could not check Claude on the selected Machine.
- Residual risk: all Agent-driven parity, approvals, service placement, widget writes, tree/SCM rows, and file Actions remain unverified until the stack-owned nl1 daemon is reachable. Screenshot artifacts are also unavailable because authenticated screenshot persistence outside this append-only report was denied.

STATUS: DONE

## Round 4

### Outcome

Round 4 removed the Round-3 startup blocker only far enough to prove one real connected-profile turn. On Machine `883d`, the connected Claude profile cleared the native-sign-in admission state, a valid Haiku prompt enabled Start, the Session was created, and the Agent replied `MQA4 session ready.` Subsequent Action-parity input was first refused as `This provider is unavailable on the selected machine`, then queued into the inactive Session; the explicit Resume attempt failed. UI-only probes independently found that widget Add still never settles, the Git/SCM surface chooses an unavailable Sapling executable, file Open requires an unavailable direct Machine transfer, and Local services cannot scan the reachable checkout. The stack was never restarted.

### Runtime basis

- PASS before and during QA: HTTP `200` at `http://happier-agent-qa-l12-main.localhost:3011`; stack metadata remained `runtime.health.status=healthy`, daemon target `nl1` `running`, selected=loaded daemon identity `4e21a62483c613be`, selected=loaded server identity `0786d0c16e6d988d`.
- Browser owner label: `mqa4`, CDP forwarded from the QA host selected by the repository browser owner. Four launcher attempts were made because the first three native-PTY handles stayed silent and process inspection initially missed their `MainThread` command names; two later emitted buffered readiness, and the fourth pseudo-TTY owner was used for QA, so this lane briefly created duplicate `mqa4` browsers. The three owners that exposed exact remote Chromium PIDs were verified absent at closeout. Ctrl-C cleanup emitted repeated remote-custody `Too many open files`; two delayed launchers exited 1, the exercised owner exited 0, and the oldest silent local launcher never exposed readiness, ignored INT/TERM, and was force-ended by its three exact local PIDs. No local `mqa4` launcher remained. The shared stack was not stopped or restarted.
- Authenticated Account restored with the recovery key read through stdin into the restore field only; the value was never printed.
- Fresh reachable fixture: added existing git checkout `/home/happier/mv3-project` on Machine `883d` as Project `mv3-project`. The retained `mqa2-r2-project` was also reachable as a Project, but its Local services scan failed.

### Scenario replay

| Scenario | Steps | Expected | Observed | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- | --- |
| 1. New Session | Selected Machine `883d`, connected `Claude · ai1@happier.dev`, Haiku 4.5; verified empty submit disabled, filled a valid prompt, started the Session and waited for the reply. Repeated at 390 px. | Connected profile clears native-sign-in admission; Start enables; Session runs. Footer remains usable without real overflow and a fresh connected-profile draft does not retain `Couldn’t check this machine`. | Start enabled and the Agent replied `MQA4 session ready.` The initial native-profile draft showed `Claude · Couldn’t check this machine`; selecting the connected profile removed that active-composer status. At 390 px body/document widths both remained 390 px; the 2,173 px chip strip was an intentional 238 px horizontal scroller with visible left/right controls, while host actions wrapped above it. The shared Account had online Machines and configured QA ACP entries, so literal zero-Machine/no-ACP states were not reachable without mutating shared prerequisites. | `.happier/design-lab/lane12-final/live/mqa2-r4-new-session-ready.png`; `mqa2-r4-footer-390-closed.png`; `mqa2-r4-session-started.png` | **PASS for connected-profile create/run and 390 layout; zero-Machine/no-ACP branch UNRUN** | N/A |
| 2. Action parity | UI: opened Settings → Actions, opened `Attach browser annotation comment`, changed in-app policy Default → Allowed → Default and verified each radio; opened Project/Files tabs. Agent: queued a phase-1 request for settings set/reset, tab open, scripts/output, operations and memory using exact Action ids, with instructions to stop before any approval. Inspected destructive `Remove widget` policy. | UI and Agent perform matching operations; dangerous deny has no effect, approval has exactly one effect; unknown clients refuse truthfully. | UI policy change/reset passed and the Actions detail stayed responsive. Automatic title Actions in the first turn truthfully returned `target_unavailable`. The parity prompt was refused once as provider unavailable, then queued; Resume failed with `Failed to resume session`. Therefore Agent settings/tab/script/output/ops/memory and dangerous deny/approve were not issued. `Remove widget` is published at the canonical policy surface, but its actual Ask-first prompt was not reached. | `mqa2-r4-actions-setting-reset.png`; `mqa2-r4-agent-resume-failed.png` | **PARTIAL: UI PASS; truthful unavailable PASS; Agent matrix BLOCKED/FAIL** | None |
| 3. Service Move | Opened Local services for both `mv3-project` and `mqa2-r2-project`; attempted to reach the product-owned service fixture/add flow before exact/Auto placement and Agent discovery. | Add a trivial service, review exact and Auto/pool targets, approve one stop/start, refuse changed target, and discover via `action.spec.search`; replay through Agent. | Both surfaces reported `Local service scan needs attention`; `mqa2-r2-project` additionally rendered the plugin view unavailable. No add control or service row became reachable, so no fixture, review, move, mismatch, stop/start, or `action.spec.search` invocation occurred. | `.happier/design-lab/lane12-final/live/mqa2-r4-mv3-project.png` | **BLOCKED/FAIL: product service scan unavailable** | None |
| 4. Live-only secret approval / plugin diagnostics | Monitored the authenticated console and Plugin Inspector; attempted the Agent prerequisite without entering any secret beyond the recovery restore field. | Secret custody is live-only and plugin diagnostics settle truthfully. | Secret approval could not be issued after Session resume failed. Console repeatedly emitted `[PluginUiExecutableModuleHost] plugin_cleanup_failed:happier.triage`; Plugin Inspector reported inventory unavailable and the Project Sessions/plugin surfaces also became unavailable. No secret value was disclosed or persisted by this lane. | `mqa2-r4-agent-resume-failed.png` | **Secret BLOCKED; plugin diagnostics FAIL** | None |
| 5. Widgets | On `mv3-project`, exercised disclosure, searched for the Round-3 `qaf3` fixture (absent), selected `Channels`, and invoked Add to the side area; waited 20 seconds, captured, closed the picker, and checked the layout. | UI and Agent add/remove/rearrange a widget and group; every write settles exactly once. | Existing widgets collapse/expand correctly. `qaf3` was absent from the loaded catalog. `Channels` remained `Loading... Add to mv3-project` after 20 seconds; after closing the picker no Channels widget existed. The add failure prevented a safe remove/rearrange/group replay, and Agent parity was blocked. | `mqa2-r4-widget-add-stuck.png` | **FAIL: Add still does not settle; disclosure PASS; remaining matrix BLOCKED** | `84ed7eea57` candidate remains not live-verified |
| 6. Tree rows / SCM | Expanded `apps` → `ui` → `sources`; focused `apps`, pressed ArrowDown and verified focus moved to `ui`, then ArrowRight and verified `aria-expanded=true`; selected the Git tab and retried SCM. | File/SCM trees support disclosure, keyboard focus, long names and selection. | File rows and keyboard disclosure passed on the real fixture. The available fixture did not expose a discriminating long-name row in the loaded slice. Git/Local Changes failed truthfully: `Unable to determine whether this path is a Sapling repository: SCM executable not found for sapling-cli (sl)` / `Source control is unavailable for this session.` | `mqa2-r4-tree-git.png` | **PARTIAL: file tree/keyboard PASS; SCM FAIL; long-name case UNRUN** | None |
| 7. File read/write/Open Actions | Opened the full Files pane, selected `README.md`, and inspected the created file tab; attempted the Agent prerequisite. | UI and Agent read/write/Open the same file through admitted Actions. | Folder listing and file selection worked, but the file tab rendered `Couldn’t open README.md · A direct machine connection is required for this transfer` and `This file couldn’t be read.` No write was attempted after the read/Open authority failed; Agent Actions were blocked by resume failure. | `mqa2-r4-file-open.png` | **FAIL: Open/read transfer unavailable; write/Agent BLOCKED** | None |

### Validation and adversarial closeout

- No source changes, commits, tests, typechecks, builds, or Actions performance measurement were made/run; MFIX9 owns the skipped performance measurement and MGATE3 owns package gates.
- Alternative-cause check: HTTP and stack metadata stayed healthy while the live UI could browse `/home/happier` and list Project files, so the failures are not equivalent to a stopped stack. Conversely, direct transfer, SCM, plugin inventory, service scan, and Session resume each failed at their own surfaced boundary; passing directory listing does not prove those paths.
- Neighboring-case check: the Agent completed one turn before the resumable-session failure; UI Action policy write/reset passed; file-tree RPCs passed; widget disclosure passed. Those successes prevent attributing every failure to one blanket daemon outage.
- Hypothesis lock: widget evidence proves missing settlement/effect, not whether admission, approval, persistence, or projection lost the write. SCM evidence proves the loaded owner selected an unavailable Sapling executable, not why. The Agent evidence proves Resume failed after the Session became inactive, not the daemon/process root cause.
- Residual risk: Agent Action parity, dangerous approvals, secret custody, service placement/discovery, widget writes/group operations, SCM rows, and file Action read/write/Open remain unverified or failed on the loaded Round-4 stack. `plugin_cleanup_failed:happier.triage` remains reproducible. The QA browser owner also has a cleanup/resource defect: remote custody exhausted file descriptors during three observed shutdowns. The three known remote browser PIDs and every local `mqa4` launcher were absent at closeout, but the oldest silent attempt never exposed a remote PID.
- Post-QA closeout: a fresh HTTP probe returned connection refused (`curl` exit 7, HTTP `000`). Read-only `hstack agent-qa-l12-main info --json` then reported the stack owner and remote `nl1` daemon still running, but the local server/UI down and `runtime.health.status=degraded` with `server_down`; `uiUrl` was null. This changed after the HTTP-200 scenario run. The lane did not restart or otherwise mutate the stack.

STATUS: DONE

## Round 5

### Outcome

Round 5 is **BLOCKED at the required current-source UI entry point**. The lane-owned `mqa5` Chromium, a controller-side HTTP probe, and an exact `nl1` HTTP probe all failed to connect to the supplied live render origin on port `19364`. The named stack itself remained healthy: server/UI port `3011` returned HTTP 200 and the remote daemon reported `running`. I did not use that exported UI as a substitute because the stack began at 12:03 local time, before MFIX13, MFIX14, and MFIX15 committed at 13:34–13:50, and stack metadata explicitly reports `expo: null`, `borrowedExpo: null`, and `sourceUi: export`. No stack component was restarted or stopped.

### Runtime basis

- Required URL: `http://happier-agent-qa-l12-main.localhost:19364/?server=http://happier-agent-qa-l12-main.localhost:3011&happier_hmr=0`.
- Browser owner: `mqa5` on `nl1`, remote Chromium PID `2426102`, CDP forwarded on controller port `36483`.
- Browser observation: navigation failed with `net::ERR_SOCKS_CONNECTION_FAILED`; the rendered browser error was saved as `.happier/design-lab/lane12-final/live/mqa2-r5-render-unavailable.png`.
- Independent probes: controller and exact-target `nl1` `curl` both exited 7 with HTTP `000` for port `19364`; controller `curl` to stack port `3011` returned HTTP 200.
- Read-only stack state: health `healthy`; server/UI listening on `3011`; daemon `running` on `nl1`; selected=loaded server identity `f6e5850864be70a8`, daemon identity `3e51ae42c705fdb0`; no live or borrowed Expo.

### Scenario replay

| Scenario | Expected | Observed | Verdict |
| --- | --- | --- | --- |
| MFIX9 performance | Measure 8 s idle Actions detail, 8 s policy toggle, Home idle and Projects idle; compare task/script time, longest task and heap delta with MFIX9. | The required current-source renderer did not accept a connection, so no app frame or Performance metrics existed to measure. The older export was not used as replacement evidence. | **BLOCKED — current-source renderer unavailable** |
| MFIX10 file Open | Open and read `mv3-project/README.md` over the relay-safe bounded-read owner. | The Project/Files UI could not render from current source; no file read was issued. | **BLOCKED — current-source renderer unavailable** |
| MFIX12 Session continuity | Machine `883d`, connected Claude profile, Haiku Low: finish turn 1, send turn 2, stop and resume once. | No current-source New Session surface rendered, so no provider turn or resume was issued. | **BLOCKED — current-source renderer unavailable** |
| Action parity + dangerous approval + live-only secret | Settings set/reset, tab open, script/output, operations list and memory through Agent; deny one danger with no effect and approve one with exactly one effect; exercise live-only secret custody. | The prerequisite Session and Inbox surfaces were unavailable at the required origin; no effect, approval decision, or secret entry was issued. | **BLOCKED — current-source renderer unavailable** |
| MFIX11 widget Add | Add a widget on `mv3-project` and record time to terminal settlement. | The current-source Project Overview could not render; no widget mutation was issued. | **BLOCKED — current-source renderer unavailable** |
| MFIX14 approval summary | Open an Inbox approval detail and verify it leads with one plain sentence. | Inbox could not render from current source. The pre-MFIX14 exported UI was deliberately not treated as evidence. | **BLOCKED — current-source renderer unavailable** |
| MFIX15 Local services + Service Move scenario 3 | Verify services are listed on `mv3-project`; if a service exists or can be added through the product, replay exact and Auto/pool review, approval/effect and mismatch refusal. | The post-MFIX15 UI/daemon combination was not reachable through the required render path; no scan, product-owned fixture creation, or move was attempted. | **BLOCKED — current-source renderer unavailable** |
| MFIX13 Project `layoutId` route continuity | Navigate the Project route transition that retains an exact checkout and verify the intended `layoutId` survives. | The post-MFIX13 router could not render; no route transition was exercised. | **BLOCKED — current-source renderer unavailable** |

### Validation and adversarial closeout

- No source changes, commits, tests, typechecks, builds, product Actions, approvals, secrets, service mutations, or stack lifecycle operations were made/run.
- Alternative cause checked: port `3011`, stack health, and daemon health were independently green while only `19364` failed; this is a missing live-render prerequisite rather than a stopped server/daemon.
- Environment-gap check: the exported UI is provably older than MFIX13/14/15 by stack start time versus commit time, so it cannot validate the added Round-5 requirements. Using it would also violate the explicit live-render instruction.
- Visual review: no product surface rendered at the required origin, so there was no visual problem to describe and no styling change was attempted.
- Residual risk: every Round-5 product claim remains unverified. Next action is for the current-source UI owner to restore the already-designated port `19364`; then replay this table with the same healthy stack and Machine `883d`, without restarting the stack.

STATUS: DONE

## Round 5 (rerun)

### Outcome

Round 5 reached the current-source export and exercised the fresh local daemon on `NLDW6-3-11-20 · 44bd`. MFIX10 file Open, MFIX11 widget Add, and MFIX16 offline-machine truthfulness passed. The Agent-dependent matrix did not complete: one live Claude session reached its first native tool approval but every approval attempt returned `Operation failed. Please try again`; a second Project-scoped draft then remained at `Starting session…`. The product Terminal also reported that terminals were unavailable on this machine, so the fresh Project could not be initialized as Git or given a long-running service. No stack component was restarted.

### Runtime and fixture basis

- UI: `http://happier-agent-qa-l12-main.localhost:3023`, HTTP 200, source-snapshot export built from the supplied current source around 18:32; observed server build `619ec5bfa877116f` and daemon build `1389f98a6b5f8a9e`.
- Daemon: local `NLDW6-3-11-20 · 44bd0886-673f-40ef-913d-8fc280e93c82`; the retired `883d` machine remained offline and was not used as an execution target.
- Product-created fixture: Project `mqa5-project` at `~/qa-l12/mqa5-project`, with an empty `README.md` created through Files. The product reported `Not a source-control repository` and `Terminals are not available on this machine`.
- Agent evidence: session `cmv43e9lq0067m2xmuclhiw74` used the connected Claude profile and Haiku 4.5. It rendered the expected single composer status line (`NLDW6-3-11-20 · This Home · No folder`) before its first tool approval failed.

### Scenario evidence

| Scenario | Steps and expected result | Observed current-source result | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- |
| MFIX9 Actions performance | Measure warmed 8 s idle windows on Home, Projects, and one Action detail; then toggle one non-dangerous policy and measure 8 s. Expected detail churn materially below MFIX9's pre-fix `+4.060 s` task / `+2.018 s` script, with an app-wide owner identified if other pages remain hot. | Home: `+7.994 s` task / `+2.325 s` script / `-204,521,144 B` heap. Projects: `+6.841 s` / `+6.105 s` / `-210,837,600 B`. Action detail: `+4.935 s` / `+0.814 s` / `-257,522,684 B`. Negative heap deltas show GC, not a leak. The policy mutation was rejected by the execution sandbox, and the long-task observer could not be retrieved while the renderer was saturated. Repeated machine-refresh console events are a candidate, not a proven cause. | — | **PARTIAL / FAIL — high app-wide renderer task time remains; toggle comparison and longest task unavailable** | None |
| MFIX10 File Open | Open the fresh Project's `README.md` through Files. Expected a relay-safe read rather than a direct-connection error. | The file opened in a detail tab and truthfully rendered `File is empty`; no direct connection or bounded-read error appeared. | `live/mqa2-r5r-widget-added.png` | **PASS** | None |
| MFIX12 session continuity + MV6B composer | Start connected-profile Claude, finish turn 1, send turn 2, stop/resume once. Expected both turns and resume to work; composer should retain one calm status line. | First session started and showed the single status line, but its first `Terminal(cmd: mkdir)` approval repeatedly ended in the inline error `Operation failed. Please try again.` Turn 1 never completed. A second Project draft remained at `Starting session…` and the renderer stopped responding. Turn 2 and stop/resume were unreachable. No visual-layout defect was observed; the failure is functional. | `live/mqa2-r5r-session-approval-failed.png` | **FAIL — approval/start lifecycle prevented continuity proof** | None; nearby `transcript identity proof follow failed` log entries were not sufficient causal proof for a safe owner fix |
| Agent Action parity + dangerous approval + live-only secret | Through a working Agent, set/reset a setting, open a tab, run/open Project output, list operations, read memory, deny one dangerous Action with no effect, approve one with exactly one effect, and exercise live-only secret custody. | No working turn survived the first native tool approval, and the retry draft never left `Starting session…`; no Action effect or secret was issued. | `live/mqa2-r5r-session-approval-failed.png` | **BLOCKED — working Agent session prerequisite failed** | None |
| MFIX11 widget Add | Add a Project widget and record terminal settlement. Expected exactly one visible effect. | Added built-in Code to the side area. The action showed `Code added` and the Overview contained exactly one additional Code widget after `12.575 s`; the dashboard changed to `Overview Edited`. | `live/mqa2-r5r-widget-added.png` | **PASS** | None |
| MFIX14 approval summaries | Open an approval detail produced by the current summary owner. Expected one human sentence before structured Details, e.g. `Add “Qaf1 Usage b” (small) to Usage · Main area.` | The inspected Add widget approval was 17 hours old and showed Status then structured fields without a summary. That artifact predates the current producer, so it does not refute MFIX14. A fresh Action approval could not be produced because both Agent attempts failed before Action execution. | `live/mqa2-r5r-approval-summary-missing.png` | **BLOCKED / INCONCLUSIVE — only a legacy approval was available** | None |
| MFIX15 service scan + Service Move scenario 3 | Discover a fresh long-running service, then review exact-machine and Auto/pool moves, approve one stop/start effect per machine, refuse a changed target, and find the operation through `action.spec.search`. | The daemon accepted `daemon.localServices.inventory.watch` and returned a result; no strict-schema error was logged. The UI nevertheless settled at `Unavailable — This service is unavailable right now.` Because Terminal and the Agent fixture path both failed, no service could be created and no Move review, effect, mismatch refusal, or Action search was reachable. | `live/mqa2-r5r-service-unavailable.png` | **FAIL scan presentation; BLOCKED Move scenario 3** | None; daemon success versus UI unavailable needs owner-level correlation before changing source |
| MFIX13 Project `layoutId` continuity | Transition an exact qualified checkout while carrying a valid non-default dashboard `layoutId`. Expected the id to survive. | The exact Project route worked with `worktreeId=@root` and the current server, but its Overview used the default dashboard and carried no `layoutId`. A manually supplied nonexistent id correctly did not establish a valid dashboard context; creating persistent dashboard state was not authorized by the execution sandbox. No valid live transition was available. | `live/mqa2-r5r-widget-added.png` | **BLOCKED / INCONCLUSIVE — no valid non-default layout fixture** | None |
| MFIX16 offline machines | Open retired machine `883d`. Expected offline state never to be presented as a healthy current resource read. | The row and settled detail text both said `Offline`; detail said it cannot start sessions, has not reported resources since Happier opened, and an agent cannot inspect it now. Only explicit last-report explanations were offered. | `live/mqa2-r5r-offline-machine.png` (captured during the detail's transient Loading state; the settled state is preserved in the browser text evidence) | **PASS** | None |

### Validation and adversarial closeout

- No production source, tests, commits, stack lifecycle, secrets, approval decisions, or service mutations were made. The only product mutations were creating the fresh Project/folder/empty README and adding one Code widget.
- Alternative cause check: MFIX14's missing sentence was observed only on a pre-fix artifact, so it is not reported as a current producer regression. Conversely, the service daemon returned a result while the UI said Unavailable, so the service failure is not attributed to a dead daemon.
- Blast-radius check: high task time reproduced on Home and Projects as well as Action detail, which rejects a detail-only MFIX9 explanation. The exact refresh owner remains unproven.
- Visual review under `happier-ui-craft`: the composer retained one compact status line and no clipping was observed. The Project artwork remains visible through translucent content, materially reducing contrast around the README/Add-to-Overview controls in `live/mqa2-r5r-widget-added.png`; this styling issue was described only, not changed. Functional errors were not relabeled as visual defects.
- Residual risk: session turn 2/resume, the Agent parity/secret matrix, a fresh MFIX14 summary, MFIX15 service Move, and a valid MFIX13 non-default-layout transition remain unverified. The renderer twice became non-responsive after session lifecycle failures; the stack itself remained running.

STATUS: DONE

## Round 6

### Outcome

Round 6 reached the supplied 22:05 export on `NLDW6-3-11-20 · 44bd`, restored the Account key through stdin without disclosure, and reproduced the app-wide idle CPU failure. A paused renderer stack identified the canonical machine/session-list impact owner: heartbeat-only machine updates scanned every session before deciding that project grouping was unchanged. I fixed that owner with test-first RED → GREEN and committed `da96df4c7b` (`perf(ui): skip session scans for heartbeat updates`). The running export predates this commit and could not be restarted, so post-fix live measurement and the interaction-dependent remainder are blocked rather than claimed.

### Runtime and performance evidence

- UI: `http://happier-agent-qa-l12-main.localhost:3023`; supplied source-snapshot export built around 22:05; stack was never restarted or stopped.
- Browser owner: label `mqa6`, CDP browser on `nl1`; Account recovery key was piped from `.happier/qa/unified-work-live/state/dev-test-account.key` into the restore field only and never printed.
- Warmed 8 s Home: task `+7.977132 s`, script `+3.636388 s`, longest task `7,699 ms`, heap `+134,296,616 B` (Round-5 task baseline `+7.994 s`).
- Warmed 8 s Projects: task `+8.055509 s`, script `+5.493754 s`, longest task `7,699 ms`, heap `+169,667,388 B` (Round-5 task baseline `+6.841 s`).
- The renderer paused inside `resolveMachineSessionListIndexImpact` via `resolveSessionProjectGroupingKeyParts`/Zod parsing. The owner now rejects activity-only machine changes before reading session metadata. Screenshots: `.happier/design-lab/lane12-final/live/mqa2-r6-home.png` and `mqa2-r6-projects.png`.

### Scenario replay

| Scenario | Observed current-source result | Verdict |
| --- | --- | --- |
| MFIX17 warmed idle CPU | Home remained effectively equal to Round 5 and Projects regressed; both exposed one 7.699 s long task. The owner-level heartbeat/session scan defect was reproduced and fixed in source. The no-restart export could not provide post-fix live numbers. | **FAIL on loaded export; source fix GREEN; live recheck BLOCKED** |
| MFIX18 native approval and session continuity | The unchanged renderer became non-responsive while entering Settings → Actions; subsequent accessibility snapshots timed out. A trustworthy turn-1 approval, turn 2, and stop/resume replay was not reachable after the blocking perf failure. | **BLOCKED by loaded-export perf defect** |
| Terminal, Git fixture, and Services Move | The required Terminal creation of the Git/service fixture and all dependent empty-state, exact/Auto placement, stop/start, changed-target refusal, and search steps require the blocked interactive renderer. No product or service mutation was issued. | **BLOCKED by loaded-export perf defect** |
| Agent Actions matrix, dangerous approval, secret, and fresh summary | No working post-baseline Agent turn was issued; no approval decision, Action effect, or secret entry occurred. | **BLOCKED by loaded-export perf defect** |
| Offline-machine truthfulness and 44bd default controller | The loaded Projects shell displayed one online and 88 offline Machines, but the required settled details for `33fc`, `7b41`, and `4633`, plus fresh Create default selection, could not be reached after saturation. | **BLOCKED / not inferred from shell counts** |
| 390 px armed Continue | No qualifying armed session could be established, so rail overlap was not evaluated. | **BLOCKED by Agent/session prerequisite** |

### Fix, validation, and closeout

- RED: the owner test threw when an activity-only heartbeat caused session metadata to be read. GREEN: `machineSessionListIndexImpact.test.ts` passed `1/1` through `./apps/stack/bin/hstack-exec --target=nl1 -- ...`.
- The broader neighboring suite proved the new case GREEN but still exited with three unrelated moving-tree failures: export import timeout, legacy profile-id index expectation, and a display-identity no-op expectation. No package gate was run; MGATE3 owns it.
- Split-brain audit: `machineSessionListIndexImpact.ts` remains the single impact decision owner called by `machines.ts`; no parallel heartbeat filter was added. The change only short-circuits when replacement and grouping-renderable fields are unchanged.
- Visual review: the two reachable shells showed no new layout defect; all observed blocking behavior was functional, so no styling was changed.
- Adversarial check: authentication/startup cost does not explain the warmed repeated 7.699 s tasks; the paused stack directly reached the session scan from machine application. Conversely, the source test does not establish post-fix browser performance, so live success remains unclaimed. Residual risk is the full approval, session, terminal, service, Actions, offline-detail, and 390 px matrix until Main supplies an export containing `da96df4c7b`.

STATUS: DONE

## Round 7

The complete Round 7 outcome, measurements, scenario matrix, fix evidence, and residual risk are recorded above under **Round 7 evidence**.

STATUS: DONE


## Round 8

### Outcome

Round 8 reached the supplied 04:15 export on `NLDW6-3-11-20 · 44bd` and restored the Account key through stdin without disclosure. MFIX19 did not make the loaded app idle: Home, Projects, and an Action detail each consumed almost their complete warmed eight-second windows. The CPU profile still contained usage and plugin-origin work, but its dominant new stack was secondary-Home ordinary Session-list refresh opening every Session owner envelope through `fetchAndApplySessions`. I fixed that canonical refresh owner test-first and committed `a2c8439693` (`perf(ui): bound secondary Home session hydration`). The no-restart export predates the fix; it intermittently recovered enough to finish all three measurements, but a connected-profile Claude draft still reported `Couldn’t check this machine` and kept Start disabled, so the Agent-dependent remainder is blocked rather than claimed.

### Runtime and performance evidence

- UI `http://happier-agent-qa-l12-main.localhost:3023`; stack health `healthy`; server selected=loaded `c7f9bfaa8bbccc1a`, daemon selected=loaded `0c2102863cbb1f6e`; source-snapshot export; no stack restart or stop.
- Browser label `mqa8`. The first `linux3` owner exited after authentication and its CDP forward became connection-refused; the replacement owner on `nl1` used CDP `http://127.0.0.1:36487`. The recovery key was streamed to a DOM assignment through `agent-browser eval --stdin` and never appeared in arguments or output.
- Warmed Home: task `+7.935468 s`, script `+3.092659 s`, heap `+179,630,016 B`, 137 long tasks, longest `5,351 ms`. A later warmed Home window remained hot at task `+7.908612 s`, script `+4.325101 s`, heap `-55,438,680 B`.
- Warmed Projects: task `+7.969237 s`, script `+3.299874 s`, heap `-160,095,296 B`, 38 long tasks, longest `1,919 ms`.
- Warmed Action detail: task `+7.594660 s`, script `+2.900732 s`, heap `+126,718,612 B`, 57 long tasks, longest `1,499 ms`.
- An 8 s CPU profile sampled `openSessionOwnerMetadataEnvelopeV1` under `fetchAndApplySessions`/background row hydration as the dominant path (`t._zod.check`: 43,283 samples). It also still sampled `addUsageCostForMode` (519), `buildPluginMachineExecutionOriginCandidates` (48), and `serializePluginMachineExecutionOriginMachineFacts` (42); `resolveMachineSessionListIndexImpact` was absent. Screenshots: `live/mqa2-r8-home.png`, `live/mqa2-r8-projects.png`, `live/mqa2-r8-action-detail.png`, and `live/mqa2-r8-saturated.png`.

### Scenario replay

| Scenario | Observed current-source result | Verdict | Fix commit |
| --- | --- | --- | --- |
| MFIX17/MFIX19 warmed idle CPU | All three required surfaces remained saturated. Secondary-Home ordinary refresh was the next load-bearing owner: unlike the focused Home it omitted the shared zero-background-hydration bound, so lightweight list refreshes opened every generic row and repeatedly patched global state. The fix preserves active, attention, explicitly demanded, and query-page hydration while suppressing only undemanded ordinary background opens. | **FAIL on loaded export; source fix GREEN; live recheck blocked by no-restart build** | `a2c8439693` |
| MFIX18 native approval and session continuity | On `NLDW6-3-11-20`, folder `~/qa-l12/mqa5-project`, connected `Claude · ai1@happier.dev`, and Haiku 4.5, a valid no-tool prompt still showed `Claude · Couldn’t check this machine`; Start remained disabled. No native approval, turn 1/2, or stop/resume was reachable. | **FAIL — connected-profile session admission unavailable on loaded export** | None; screenshot `live/mqa2-r8-session-blocked.png` |
| Terminal, Git fixture, and Services Move | The renderer's sustained saturation and failed Session/machine admission prevented a trustworthy Project terminal, Git/service creation, empty/new-service states, exact/Auto review, stop/start, changed-target refusal, or `action.spec.search`. No service mutation was issued. | **BLOCKED by loaded-export machine/session prerequisite** | None |
| Agent Actions, dangerous approval, secret, and fresh summary | With no runnable Agent Session, no settings/tab/script/output/ops/memory Action, dangerous deny/approve, live-only secret, or fresh approval detail was issued. | **BLOCKED by Agent prerequisite** | None |
| Offline-machine truthfulness and 44bd default controller | The shell truthfully showed 11 Machines needing attention, but settled details for `33fc`, `7b41`, and `4633` and a fresh Create default were not reached after the admission failure; no conclusion is inferred from counts or the selected draft label. | **BLOCKED / unverified** | None |
| MV6C 390 px armed Continue | No qualifying armed Session existed because Start was disabled, so the Continue/chip-rail overlap state was unreachable. | **BLOCKED by Session prerequisite** | None |

### Fix, validation, and closeout

- RED: after repairing the stale `serverProfiles` mock through the existing partial-mock testkit, the focused owner assertion failed because `sessionListBackgroundHydrationMaxRows` was absent. The first two attempts were invalid setup evidence (missing mock export, then default-heap OOM); the valid 8 GiB run failed on the intended missing field.
- GREEN: the same assertion passed with the owner fix. Its broader file finished 24/26 tests green and retained two unrelated moving-tree failures in reachability/warm-cache expectations. `nl1` validation was unavailable because its repository replica reported 60 unrelated `.translation-types-*` transition problems, so the deciding RED/GREEN ran through the wrapper on `linux3`. No package typecheck/build ran; MGATE3 owns it.
- Split-brain audit: `fetchAndApplySessions` remains the sole hydration-priority owner. The secondary ordinary-refresh caller now supplies the existing owner boundary already used by focused Home tuning; demand/query reads were deliberately unchanged, and no second hydration policy or consumer-side row filter was introduced.
- Visual review under `happier-ui-craft`: Home, Projects, Actions, and the blocked composer showed no new clipping or hierarchy defect. The observed failures were functional saturation/admission failures, so no visual source was changed.
- Adversarial check: machine heartbeats alone do not explain the sampled envelope-open stack; the profile directly entered secondary ordinary snapshot hydration. Conversely, the source GREEN cannot prove browser improvement because the loaded export predates `a2c8439693`. Residual risk is post-fix live performance plus the complete approval/session/terminal/service/Action/offline-detail/390 px matrix.
- The lane-owned replacement browser was closed with Ctrl-C after evidence capture; the shared stack was left running.

STATUS: DONE

## Round 9

### Outcome

Round 9 used a fresh lane-owned Chromium profile against only `agent-qa-l12-main` and left the supplied stack running. The client is no longer saturated on every surface, but warmed Home remains hot; the exact server PID `2147536` and its daemon also remained continuously CPU-hot under session-follow/Prisma contention. The functional replay reached a real Claude native-tool approval, but approval never settled or produced its filesystem effect, blocking turn 1 and every dependent Agent scenario. A fresh Create flow also defaulted to a controller already disproved by a server-scoped request. I fixed that canonical selection corridor test-first and committed `0e3a67edae` (`fix(ui): keep managed controller defaults reachable`). The running export predates the source fix, so its live correction is not claimed.

### Runtime, browser, and idle CPU evidence

- Stack/UI: `http://happier-agent-qa-l12-main.localhost:3023`, HTTP 200 before and after QA; server selected=loaded `aab6a3af27bf5adb`, daemon selected=loaded `2eed97a554ac4eda`. Server PID `2147536` remained alive. No stack or daemon was stopped or restarted.
- Fresh browser profile: `/home/ubuntu/.happier/dev-targets/linux3/0.3/tmp/hstack-ZefzaZ/hstack-qa-browser-HxE9bC`, holding only this stack's server. Remote Chromium PID `4191732` was absent after Ctrl-C closeout. The Account key was supplied through stdin and never printed.
- Warmed client windows: Home task `+4.058149 s`, script `+2.634217 s`, heap `+112,320,464 B`, 17 long tasks, longest `553 ms`; Projects `+0.991723 s`, script `+0.273398 s`, heap `+4,546,160 B`, 2 long tasks, longest `168 ms`; Action detail `+1.122477 s`, script `+0.164205 s`, heap `-434,954,376 B`, zero long tasks. A second warmed Home window remained hot at task `+5.746975 s`, script `+2.601813 s`, heap `-297,374,512 B`, 20 long tasks, longest `1,305 ms`. Negative heap deltas show GC, not a leak.
- Exact-process server sample: 10-second `pidstat` averaged server `192.8%` CPU and daemon `91.8%`, with observed peaks of `275%` and `282%`. Server `perf` evidence is `/tmp/mqa2-r9-server.perf.data` (5,525 samples, zero lost): about 75% sampled the Node main event loop and about 70% traversed async `ThreadSafeFunction`/microtask/promise fulfillment with object cloning/property work. Attach via `strace` and inspector activation were unavailable under the host security boundary and were not worked around.
- The contemporaneous daemon tail contained 19 `/ping` posts, two unmatched GETs, one unmatched HEAD, eight Machine API markers, three RPC markers, and zero `session-activity-changed` events. Direct daemon→server sockets varied `82 → 52 → 43` rather than growing monotonically. Server logs repeatedly recorded session-follow `LockAdmissionDeadlineExceededError`, `machine-update-state` internal errors, session-alive conflicts/deadlocks, and plugin-collection serializable-transaction failures. This disproves an MFIX23 activity-event storm, but does not prove which of the multiple user-scoped RPC observations owns every open socket.
- Screenshots: `.happier/design-lab/lane12-final/live/mqa2-r9-home.png`, `mqa2-r9-projects.png`, `mqa2-r9-action-detail.png`, and `mqa2-r9-create-controller-defect.png`.

### Round 6 items 2–7 replay

| Item | Observed current-source result | Verdict |
| --- | --- | --- |
| 2. Native approval + Session continuity | Created connected-profile Claude/Haiku Session `cmv4tfcjn00fam21s952yvkpk` on exact controller `44bd` and folder `~/qa-l12/mqa5-project`. The turn reached a native `printf` permission prompt. Clicking Yes once left approval pending for more than 600 seconds; `/tmp/mqa2-r9-approval.txt` remained absent. Turn 1 never completed, so turn 2 and stop/resume were unreachable. | **FAIL — approval had zero effects but never settled** |
| 3. Terminal, Git fixture, Local services, and Service Move | Project Terminal reported `Couldn't start`; no Git or long-running-service fixture could be created. Local services rendered Plugin Inspector/Installed plugins rather than an empty/new-service flow, so exact/Auto placement, stop/start, mismatch refusal, and Action discovery were unreachable. | **FAIL/BLOCKED — terminal and service entry points unavailable** |
| 4. Agent Actions, dangerous approval, live-only secret, fresh summary | The first native approval never settled, so the settings/tab/script/output/operations/memory matrix, dangerous deny/approve, live-only secret, and fresh approval summary were not issued. No secret was entered or disclosed. | **BLOCKED by native approval prerequisite** |
| 5. Offline-machine truthfulness | Opening Processes on `33fc` triggered a real request; `33fc` and `4633` then demoted to `Can't reach from this Home`, while `7b41` remained Offline. | **PASS — failed requests overrode stale pushed presence** |
| 6. Fresh Create default controller | Fresh Create initially selected `NLDW6-3-11-20 · 0371` instead of the only request-proven reachable `44bd`, reproducing a split between presence projection and retained automatic choice. | **FAIL on loaded export; source fix GREEN** |
| 7. MV6C at 390 px | At 390×844 the direct Session route remained on Loading with only the tab rail visible; no qualifying armed Continue state existed. | **BLOCKED — armed Session prerequisite absent** |

### Fix, validation, and adversarial closeout

- Canonical owner: machine-administration target projection plus `useManagedControllerScope`'s automatic draft choice. Request reachability already owns the server-scoped negative observation; the fix makes both snapshot/current candidate projection consume that owner and drops only an automatic retained controller after an observed request failure. Explicit user choices and preferred draft controllers remain exact.
- RED: `targetState.test.ts` expected a fresh pushed Machine with a failed server-scoped request to project offline but received online; `MachineProvisionerPicker.test.tsx` expected the automatic choice to move from `a` to `z` after the failed request but retained `a`. GREEN: both focused files passed, 22/22 tests, in `74.67 s` through `./apps/stack/bin/hstack-exec --local --script=vitest:local -- run ...`.
- `git diff --check` passed. The public UI typecheck was attempted through `./apps/stack/bin/hstack-exec --script=typecheck:local`; it failed before TypeScript compilation while preparing unrelated workspace package `@happier-dev/plugins-xai` (`corepack` exit 2). This is a missing package gate, not a reported type error.
- Split-brain audit: `machineReachability` remains the only negative-request authority, candidate projection remains in `targetState.ts`, and `useManagedControllerScope` remains the default-selection owner. No parallel reachability store or consumer-local timeout was added. Concurrent same-file translation/Home-label work was preserved outside the commit; the shared index was realigned only for the four committed paths.
- Adversarial check: Home-specific heat may depend on this Account's large draft/usage data and does not generalize to Projects or Action detail. The server evidence identifies the session-follow/Prisma transaction corridor, not an exact source-level loop, so no speculative server fix was made. The source GREEN cannot establish live browser behavior because stack restart was forbidden. Residual risk: post-fix live Create selection, server/daemon idle CPU root cause, native approval settlement, Session continuity, Terminal/Services, Agent Actions/secret/summary, and armed 390 px Continue remain failed or unverified.

STATUS: DONE

## Round 10

### Outcome

Round 10 could not reach the required borrowed current-source UI, so no functional product verdict or source fix is claimed. The supplied `agent-qa-l12-main` server/export remained healthy on `:3023`, but the explicitly required borrowed Metro endpoint on `:19364` refused connections. The owner development stack independently reported no running UI process and no UI port. Two fresh lane-owned browser attempts (automatic `linux2`, then explicit `linux3`) both reached `chrome-error://chromewebdata/` with `ERR_SOCKS_CONNECTION_FAILED`. Per the Round 10 contract, I did not substitute the stale `:3023` export, restart any stack or daemon, or touch another program's runtime. Local services was skipped as instructed.

### Runtime and browser evidence

- `agent-qa-l12-main` remained healthy with server PID `2147536`, daemon PID `2158705`, server selected/loaded `aab6a3af27bf5adb`, daemon selected/loaded `2eed97a554ac4eda`, and export HTTP 200 on `:3023`.
- The required borrowed URL `http://happier-agent-qa-l12-main.localhost:19364/?server=http://happier-agent-qa-l12-main.localhost:3023&happier_hmr=0` returned HTTP 000 / connection refused from the controller.
- Read-only `stack info repo-dev-a1cc5e0671 --json` showed owner/server processes alive but `runtime.components.ui.running=false`, `runtime.components.ui.pid=null`, `runtime.expo.webPort=null`, and `urls.uiUrl=null`; no restart or mutation was attempted.
- The first fresh browser selected `linux2` and failed navigation with `ERR_SOCKS_CONNECTION_FAILED`. I closed only that browser, temporarily selected the brief's known-good `linux3` browser host, immediately restored the stack QA target setting to `nl1`, and retried. The `linux3` browser failed identically and was closed with Ctrl-C. Screenshot: `.happier/design-lab/lane12-final/live/mqa2-r10-source-ui-unavailable.png`.
- Authentication was not reachable. The development test key was neither read nor printed.

### Scenario results

| Scenario | Steps and expected result | Observed current-source result | Evidence | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- |
| 1. Native approval and Session continuity | Open the borrowed source UI; start a fresh connected-profile Claude/Haiku Session on `44bd`; approve one native tool request for exactly one effect; finish turn 1, send turn 2, then stop/resume once. | The source UI could not load on either fresh browser, so no Session or approval was created and no effect was attempted. | Controller `:19364` HTTP 000; both browsers `ERR_SOCKS_CONNECTION_FAILED`; screenshot above. | **BLOCKED — current-source UI prerequisite absent** | None |
| 2. Agent Action matrix | Through a working in-app Agent, set/reset a setting, open a tab, run/open script output, list operations, read memory, deny one dangerous Action with no effect, approve one with exactly one effect, exercise live-only secret approval, and inspect a fresh one-sentence approval summary. | No in-app Agent could be started without the required source UI. No Action, approval, setting, script, memory, or secret operation was issued. | Same source-UI evidence. | **BLOCKED — Session/UI prerequisite absent** | None |
| 3. Project Terminal on `44bd` | Open the Project Terminal and observe either a successful terminal or its exact truthful refusal reason; repair test-first only if a Happier defect is reproduced. | The Project surface was unreachable, so terminal start/refusal was not invoked and no terminal defect was inferred. | Same source-UI evidence. | **BLOCKED — source UI absent** | None |
| 4. Fresh Create default controller | Open a fresh Create flow and verify the automatic controller is the request-proven reachable `44bd`. | Fresh Create was unreachable. The Round 9 source fix could not be re-verified live, so no pass is claimed. | Same source-UI evidence. | **BLOCKED — source UI absent** | None |
| 5. MV6C at 390 px | At 390 px, arm “Continue via…” and verify it does not cover the chip rail; report composer visuals without modifying MV7's concurrent status-line work. | No authenticated Session/composer rendered. No visual product judgment or source change was made. | Same source-UI evidence. | **BLOCKED — authenticated source composer absent** | None |
| 6. Machine reachability (MFIX24) | Produce a failed Machine request, verify “Can't reach” survives heartbeats, then perform a successful request and verify recovery. | Machine pages and requests were unreachable. No failed/successful request pair was produced, so the observed state transition remains unverified. | Same source-UI evidence. | **BLOCKED — source UI absent** | None |

### Closeout and residual risk

- No Happier behavior defect was reproducible behind the missing UI prerequisite, so TDD and a production fix were not applicable. No focused test, typecheck, or build was run.
- The required loaded-current-source evidence remains missing for native approval settlement, turn continuity, the Agent matrix, Terminal truthfulness, fresh Create selection, 390 px armed composer layout, and failed-request reachability persistence/recovery.
- Adversarial check: the healthy `:3023` export and live server/daemon disprove a blanket stack outage, while the owner stack's absent UI process plus independent controller/browser failures identify the missing borrowed Expo/Metro ingress. Falling back to the export would test bytes that predate the named Round 10 fixes and cannot falsify those fixes.
- Both lane-owned browser sessions were closed with Ctrl-C. `agent-qa-l12-main` and all other stacks/daemons were left running.

STATUS: DONE

## Round 10b

### Outcome

Round 10b is **BLOCKED before browser smoke/authentication**. The named stack and its superseding borrowed UI are healthy, but the required `linux3` QA-browser target is paused/disconnected. `dev-targets browser start ... --target=linux3` failed closed before creating Chromium. The canonical detached sync owner did not recover that target, and a target sync was denied by the execution boundary because it would export the dirty workspace without separate data-transfer authority. I did not bypass that denial, use another browser host, restart/stop any stack, read the test key, or change product source.

NEEDS-MAIN: restore the existing `linux3` target sync (or explicitly authorize the repository transfer needed to do so), then resume Round 10b against the same healthy stack and superseding URL.

### Runtime and blocker evidence

- `stack info agent-qa-l12-main --json`: health `healthy`; borrowed UI URL `http://happier-agent-qa-l12-main.localhost:19364/?server=http%3A%2F%2Fhappier-agent-qa-l12-main.localhost%3A3021&happier_hmr=0`; server PID `3871517`; daemon PID `3881626`; UI source `borrowed_expo`.
- Independent HTTP probes returned `200` for the borrowed UI and server `:3021`, so this is not an app/stack outage.
- First browser start: `linux3 synchronization status inspection failed`; no QA host had a valid memory observation; controller-local fallback was disabled. No browser PID, CDP endpoint, or foreground browser handle was created.
- `dev-targets status linux3 --json`: sync state `paused`, session `disconnected`, `paused=true`, admission observed, power policy healthy.
- `dev-targets sync-service start --detached` ended with the project service failed on unrelated target `vm` (`Mutagen initial flush failed`). Its preparation record called `linux3` ready, but the deciding direct target status remained paused/disconnected.
- A direct `dev-targets sync linux3` was denied by the execution boundary as an unauthorized remote workspace export. A browser retry was denied for the same reason. These denials were not worked around.

### Scenario results

| Scenario | Expected | Observed | Screenshot | Verdict | Fix commit |
| --- | --- | --- | --- | --- | --- |
| 0. Smoke | UI loads/signs in, daemon Machine is online, tooltip hover and Home do not crash. | HTTP delivery passed, but no browser could be created; authentication, Machine state, tooltip and Home were not exercised. The Account key was never read or printed. | None | **BLOCKED — required QA browser unavailable** | None |
| 1. Native approval and continuity | Connected-profile Claude/Haiku approval settles once; turn 2 and stop/resume work. | No authenticated browser/Session existed, so no approval or effect was issued. | None | **BLOCKED by smoke** | None |
| 2. Agent Action matrix | Settings set/reset, tab, script/output, operations, memory, dangerous deny/approve, live-only secret, fresh summary. | No in-app Agent could be started; no Action, approval, setting, script, memory or secret operation was issued. | None | **BLOCKED by smoke** | None |
| 3. Project Terminal | Starts on the reachable Machine or shows its exact real refusal. | Project UI was not reachable through the required browser. | None | **BLOCKED by smoke** | None |
| 4. Fresh Create | Default controller is the request-proven reachable Machine. | Create was not rendered. | None | **BLOCKED by smoke** | None |
| 5. MV6C at 390 | Armed “Continue via…” does not cover the chip rail. | No authenticated composer state was rendered. | None | **BLOCKED by smoke** | None |
| 6. Reachability | Failed request survives heartbeats as “Can't reach”, then successful request recovers. | No Machine request pair was produced. | None | **BLOCKED by smoke** | None |
| 7. Local services | Project shows the canonical services empty state, not Plugin Inspector. | Project services was not rendered. | None | **BLOCKED by smoke** | None |
| 8. Composer | One-line provider status; keyboard chip navigation; Action-backed mode/goal changes. | No Session composer was rendered. | None | **BLOCKED by smoke** | None |
| 9. Idle | Warmed Home/Projects/Action detail windows plus 60-second daemon CPU/open-FD peaks. | Browser-side windows and authenticated routes were unavailable; no comparable measurement was taken. | None | **BLOCKED by smoke** | None |
| MV7 owed pairs | Dark 1440, 390 light/dark and two-cause provider-binding states. | Not captured; no browser or state fixture existed. | None | **BLOCKED by smoke** | None |
| MV8 owed pairs | Queue/state pairs, every chip picker across themes/sizes/positions, nested-button probe, Edit tags/Triggers editors and non-Git Workspace-root absence. | Not captured or probed; no browser or state fixture existed. | None | **BLOCKED by smoke** | None |
| MV10 owed pairs | Hover shots, 12 after frames and button measurements. | Not captured or measured; no browser existed. | None | **BLOCKED by smoke** | None |

### Validation and closeout

- No Happier functional defect was reproduced: the blocker is QA-target synchronization/authorization outside the product surface. TDD, focused tests, typecheck and build were therefore not applicable and were not run.
- No capture files or source changes were produced. Because browser creation failed before Chromium launch, there was no browser process to SIGINT; both failed start invocations exited terminally. The stack remains running and was never restarted or stopped.
- Adversarial check: independent UI/server HTTP 200 responses falsify a stack/UI outage; direct target status falsifies a usable `linux3` browser host despite the sync-service preparation record. Using another target, a local browser, or forcing sync would violate the superseding runbook or the execution boundary.
- Residual risk: every Round 10b functional claim and every MV7/MV8/MV10 owed live pair remains unverified until the `linux3` browser prerequisite is restored.

STATUS: BLOCKED

## Round 10b continuation

### Outcome

Round 10b continuation reached the current borrowed source UI on nl3 and completed smoke, Machine replacement, the required provider fallback attempts, focused functional repair, and the available capture work. I reproduced a canonical composer-overlay defect: legacy extra chips such as Edit tags and Triggers rendered but could not open because the overlay controller incorrectly required an optional registry `controlId`. I added an owner-level RED test, removed that competing eligibility requirement, proved GREEN, and live-verified Edit tags, Triggers, and Workspace root after a full current-source reload. No visual styling was changed.

The full round remains **BLOCKED** by the named foreign provider prerequisite. Fresh Claude session `cmv62a4uv04zumcoqlgvqspa9` disconnected before its first reply and left the prompt queued; `Send now` did not recover it. Codex was unavailable on the new Machine, and both the initial install and a retry after more than ten minutes terminated at `Try again`. Therefore no truthful Agent Action matrix, native approval effect, turn 2, stop/resume, armed MV6C state, or Action-backed mode/goal change could be produced.

### Runtime and Machine evidence

- Stack `agent-qa-l12-main` remained healthy and running throughout. Server selected/loaded identity: `d715fb4df513cba0`; daemon selected/loaded identity: `1ce3f605aef169ab`; borrowed UI/server probes returned HTTP 200.
- Browser ran on nl3 against `http://happier-agent-qa-l12-main.localhost:19364/?server=http%3A%2F%2Fhappier-agent-qa-l12-main.localhost%3A3023&happier_hmr=0`. Authentication succeeded without disclosing the development key.
- New daemon Machine: `NLDW3-5-36-33 · 58f6` (`58f6e63a-cd69-4302-83f1-325d10da7ec3`). The old local QA Machine `NLDW6-3-11-20 · 44bd` was forgotten through the normal Replace action in favor of `58f6`. Other offline Machines were not mutated because the UI did not identify them as this stack's Machines.
- Smoke passed: authenticated Home rendered, `58f6` was online, a CPU tooltip hover and Home navigation did not crash, and UI/server probes were 200. Evidence: `live/mqa2-r10b-cont-smoke-home-1440-light.png`.

### Scenario results

| Item | Observed current-source result | Verdict |
| --- | --- | --- |
| 0. Smoke | UI/authentication, online Machine, tooltip, and Home all passed. | **PASS** |
| 1. Approval + continuity | Fresh Claude disconnected before reply; queued `READY` prompt and `Send now` did not recover. No approval/effect, turn 2, or stop/resume was reachable. | **BLOCKED — known provider contract failure reproduced** |
| 2. Agent matrix | Codex install failed twice, including the timed retry; the old Codex fixture was bound to an offline Machine. No Action or secret was issued. | **BLOCKED — no working Agent prerequisite** |
| 3. Project Terminal | No working Agent/Project fixture could be established on `58f6`; Terminal was not invoked and no Happier defect is inferred. | **BLOCKED by fixture prerequisite** |
| 4. Fresh Create default | Home proved `58f6` reachable, but the fresh Create selection itself was not completed. | **UNVERIFIED** |
| 5. MV6C at 390 | No qualifying armed “Continue via…” session could be produced. | **BLOCKED by Agent prerequisite** |
| 6. Reachability | No controlled failed-then-successful Machine request pair was produced. | **UNVERIFIED** |
| 7. Local services | The canonical Project services empty state was not reached on a new `58f6` Project. | **UNVERIFIED** |
| 8. Composer | Edit tags, Triggers, and Workspace root were live-verified after the owner fix. Provider status, keyboard rail navigation, and Action-backed mode/goal changes require a working session and remain blocked. | **PARTIAL — fixed legacy popovers; Agent-dependent rows blocked** |
| 9. Idle | First 60 s daemon sample: PID `346634`, CPU peak `43.0%`, FDs `149..2416`; it overlapped active QA. After closing the picker and warming Home for 8 s, a separate 60 s sample measured CPU peak `42.7%`, FDs `146..1683`, and zero samples at or above 2,000, satisfying MFIX32's FD-burst discriminator. Browser Home/Projects/Action-detail comparison was not completed. | **PARTIAL — warmed daemon FD target passed** |

### Functional fix and validation

- Canonical owner: `useAgentInputSelectionOverlayController.ts`; callers supply `AgentInputExtraActionChip.controlId` optionally, while the owner alone decides whether a collapsed-extra overlay is supported and resolves its active descriptor.
- RED: `opens a collapsed extra popover for legacy chips without a registry control id` failed because `activeSelectionOverlay` stayed `null` (1 failed, 8 passed).
- GREEN: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/ui -- yarn exec vitest run --config vitest.config.ts sources/components/sessions/agentInput/selection/useAgentInputSelectionOverlayController.test.ts` passed 9/9 tests in one file.
- Two earlier invocations from the repository root failed to resolve `@/dev/testkit`; these were harness-directory errors, not product failures. The corrected package-scoped command above is the deciding evidence.
- The public UI typecheck was dispatched and retained for more than fifteen minutes, but never reached compilation because the remote workspace publication/dependency locks stayed occupied and repeatedly changed owners. I interrupted only this lane's waiting validation process (exit 130); no stack process was stopped. This unavailable package gate is reported rather than claimed.
- Live current-source proof: Edit tags opened its searchable listbox; Triggers opened the New trigger editor; Workspace root opened its listbox. This checks neighboring legacy chips rather than only the test fixture.
- Split-brain audit: no new renderer, registry, or consumer-owned fallback was added. The controller remains the only overlay-support/resolution owner; the fix removes its unsupported `controlId` requirement in both eligibility and active-descriptor lookup.

### Capture evidence

- MV10 exact after set: `mv10-after-{home,session,settings}-{1440,390}-{light,dark}.png`; hover set: `mv10-after-hover-{open-prompts,start-dictation,header}.png`; measured Home icon buttons were 24×24 at x=1208/1232, y=437 (`mv10-after-buttons.txt`).
- MV8 available current states: `mv8-after-offline-queued-{1440,390}-{light,dark}.png`, `mv8-chips-edit-tags-1440-light.png`, `mv8-chips-triggers-1440-light.png`, and `mv8-chips-workspace-root-1440-light.png`. DOM probe found zero `button button`, `[role=button] button`, or `button [role=button]` matches.
- MV7's full two-cause binding matrix, MV8's thinking/two-queued/pending/folded-offline and every picker/position matrix, and the non-Git Workspace-root absence case were not manufactured without their live fixtures. The capture-only rule was preserved; no surface appearance changed.

### Adversarial closeout and residual risk

- Alternative cause: the legacy chips' own descriptors were valid—the same live build opened all three immediately after removing the controller's ID gate. This rejects a tags-specific renderer or stale-build explanation.
- Neighbor/blast-radius check: both descriptor forms used by the affected corridor were exercised (list-backed Workspace root/Edit tags and rendered Triggers). Registered chips that do have `controlId` retain the same owner path.
- Environment gap: Claude's strict top-level `skills` rejection and Codex installation failure prevent every Agent-dependent conclusion. No success is inferred from existing sessions on other Machines.
- Residual risk: the incomplete scenarios and capture matrices above remain open. The first non-idle FD sample exceeded the MFIX32 target; the warmed measurement below is the deciding idle evidence. No stack or daemon was restarted or stopped.

STATUS: BLOCKED

## Round 10b continuation 2

### Outcome

Round 10b continuation 2 reached the authenticated borrowed source UI on nl3 and verified the replacement Machine `NLDW3-5-36-33 · 58f6`. The MV11 offline banner was transient/stale: Home currently showed one online Machine and fresh folder browsing successfully reached `58f6`. Fresh Create also defaulted to `58f6` and preserved its choices, but Project Open was refused with `target_mismatch`. The full round remains **BLOCKED**: the connected Codex account had only 3% Session quota remaining and disconnected before the first requested approval, while the live CLI catalog exposed `GPT 6 Luna`, not the requested `gpt-6.1-luna`.

No production fix or commit was made. The Project refusal was traced to the loaded daemon's saved stack profile lacking `homeConnectionDescriptor`/exact authority even though the authenticated server endpoint published `srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN` with its exact descriptor. The loaded daemon contained the canonical descriptor-adoption implementation, and the current-source real-composition Project Open regression passed. That leaves a loaded runtime-state/lifecycle discrepancy without evidence for a missing source change; I did not add a second identity owner, hand-edit the profile, or restart the stack.

### Scenario results

| Item | Observed current-source result | Verdict |
| --- | --- | --- |
| 1. Native approval + continuity | Created Codex Session `cmv65itzr05s5mcoqpshq4b1a` on `58f6`, selected Low reasoning and the available `GPT 6 Luna`, and queued the one-command approval prompt. The connected account reported 3% Session quota remaining; resume failed before an approval appeared. No effect occurred, so turn 2 and stop/resume were unreachable. | **BLOCKED — account Session quota; requested `gpt-6.1-luna` absent from live catalog** |
| 2. Agent Action matrix | No working Codex turn existed, so settings/tab/script/output/operations/memory, dangerous deny/approve, live-only secret, and fresh Agent summary were not issued. No secret was entered or disclosed. | **BLOCKED by Agent prerequisite** |
| 3. Project Terminal | The fresh native Terminal action presented a one-sentence canonical approval summary and settled Approved. Returning to Terminal reissued a pending request rather than proving a shell; the fresh `58f6` Project could not be opened. | **PARTIAL/BLOCKED — approval summary passed; terminal shell unverified** |
| 4. Fresh Create default | Folder selection and confirmation both defaulted to `NLDW3-5-36-33 · 58f6` and labeled it Online. Opening `/home/happier/mqa2-cont2-project` preserved the choices but returned `target_mismatch`. | **PASS default / FAIL open** |
| 5. MV6C at 390 | At 390x844 the queued/Resume status did not cover the chip rail, but no qualifying armed `Continue via...` control existed after Codex disconnected. | **PARTIAL — armed state blocked** |
| 6. Reachability pair + MV11 | Home currently showed `58f6` online, and folder browsing successfully read its filesystem, disproving the old MV11 offline capture as current truth. The Project `target_mismatch` was an authenticated semantic refusal, not a failed transport, so it was not misclassified as reachability failure; no controlled failed-transport/heartbeat/success pair was produced. | **MV11 resolved; pair unverified** |
| 7. Local services | An existing offline Project opened the canonical **Local services** surface and truthful offline state, distinct from Plugin Inspector. The exact online empty state on a new `58f6` Project was blocked by Project Open. | **PARTIAL — canonical surface passed; online empty state blocked** |

### Evidence and validation

- Server and daemon stayed running with selected==loaded (`d715fb4df513cba0` / `1ce3f605aef169ab`). The borrowed UI was healthy during QA, then its external producer disappeared during closeout; final stack health was `degraded` only for `ui_down`. One Chromium was used on nl3 and stopped with SIGINT. Authentication succeeded without printing the development key.
- Current-source check: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn exec vitest run --config vitest.config.ts src/rpc/handlers/projects/registerProjectOpenRpcHandlers.test.ts -t "establishes a credential-seeded profile identity before Project Open while refusing wrong targets"` passed the file, 26/26 tests, including the named real-composition case.
- Runtime facts: the daemon profile `stack_agent-qa-l12-main__id_default` had no descriptor or authority; `/v1/features/authenticated` published the exact matching descriptor. Folder browse succeeded on the same Machine, isolating the refusal to strict Home identity admission rather than transport reachability.
- Captures: `mqa2-r10b-cont2-mv11-home-online-1440-light.png`, `mqa2-r10b-cont2-mv6c-continue-via-390-light.png` (queued/Resume partial state), `mqa2-r10b-cont2-project-open-target-mismatch-1440-light.png`, and `mqa2-r10b-cont2-local-services-offline-1440-light.png`.
- Adversarial check: a stale/offline Machine, malformed Project input, and general machine unreachability do not explain the evidence: the chooser targeted `58f6`, its filesystem request succeeded, and the refusal code came from exact Home target admission. Conversely, current source GREEN cannot prove when or why this running profile lost/failed to acquire its descriptor, so no causal source verdict or speculative fix is claimed.

### Residual risk

Native approval effect/continuity, the Agent matrix, the actual Terminal shell, armed MV6C, failed-request heartbeat persistence/recovery, and the online Local-services empty state remain unverified. Fresh Project Open remains unavailable on this loaded stack until its canonical Home descriptor lifecycle is re-established through normal runtime ownership. No stack or daemon was restarted or stopped.

STATUS: BLOCKED

## Round 10b continuation 3

### Outcome

Round 10b continuation 3 is **BLOCKED before browser startup or product interaction** by the Main-caused `agent-qa-l12-main` outage. At lane start the canonical stack inspection already reported `server_down`, `runtime_identity_pending`, and `runtime_preparing`: the borrowed Expo UI owner was running on `:19364`, but the nl3 server service was stopped and `urls.uiUrl` was null. The nl3 execution target then failed its required synchronization barrier with `happier-nl3 synchronization needs a fresh scan`. Main subsequently confirmed that its reload retry stopped the QA stack at approximately 08:47 and instructed this lane to close rather than wait for recovery.

No browser was started, so there was no lane browser handle to SIGINT. No Account key or secret was read or printed, no in-app or stack mutation was issued, and no production source or visual behavior was changed.

### Scenario results

| Required row | Observed result | Verdict |
| --- | --- | --- |
| Different connected Codex profile with quota | Authentication and the Account picker were unreachable because the server was down before browser startup. | **BLOCKED — Main-caused stack outage** |
| Native approval, exactly one effect, turn 2, stop/resume | No Session or approval was created; therefore no effect occurred and continuity was not exercised. | **BLOCKED — Main-caused stack outage** |
| Agent Action matrix | Settings set/reset, tab, script/output, operations, memory, dangerous deny/approve, live-only secret, and fresh summary were not issued. | **BLOCKED — Main-caused stack outage** |
| Terminal shell on an openable Project | No Project surface or terminal request was reached. The known fresh Project `target_mismatch` was not replayed or reclassified. | **BLOCKED — Main-caused stack outage** |
| MV12 capture-only pairs | Home 1440 light blocker line, New Session 390 light, and 1440 dark post-chip rail captures were not produced because no authenticated page rendered. | **BLOCKED — Main-caused stack outage** |

### Evidence and closeout

- `stack info agent-qa-l12-main --json` returned runtime health `degraded` with `server_down`, local server not listening, nl3 server service `stopped`, borrowed Expo `running` on port `19364`, daemon service `running`, and daemon selected/loaded identity `1ce3f605aef169ab`. The server selected identity was `d715fb4df513cba0`, but no loaded server identity was published at the aggregate runtime boundary.
- `dev-targets status nl3 --stack=agent-qa-l12-main --json` returned `state: unhealthy`, `recovery: rescan`, and a Mutagen alpha scan problem (`hashed size mismatch`) while the target remained connected. A routed nl3 command failed closed at the synchronization barrier; no local fallback was used.
- The only retry was scheduled for the required 10-minute infrastructure interval. It was cancelled with SIGINT when Main reported the stack-down cause and requested closeout. It performed no stack lifecycle action.
- No Happier functional defect could be reproduced behind the absent runtime prerequisite, so no RED/GREEN test, source fix, typecheck, build, or commit was applicable.
- Adversarial check: the borrowed Expo process alone does not establish a runnable product when its selected Home server is stopped; conversely, the sync failure and Main's reload report do not establish a Happier product defect in any requested Agent, terminal, or MV12 surface. Those rows remain unverified rather than failed.

Residual risk is the entire requested Agent/approval/continuity matrix, terminal shell, and three MV12 captures. Resume on the current stack only after Main confirms the nl3 synchronization barrier has recovered and the server, daemon, and borrowed UI are all reachable.

STATUS: BLOCKED

## Round 10b continuation 4

### Outcome

Round 10b continuation 4 is **BLOCKED by a reproducible Codex Happier-Actions availability failure**, after the independent Project, approval, continuity, Terminal, MV12, and warmed daemon-FD gates completed. The restored nl3 stack loaded server identity `6218e64047961e65` and daemon identity `f897e80afa954683`; the existing browser was the only browser used.

### Scenario results

| Required row | Observed result | Verdict |
| --- | --- | --- |
| Fresh Project Open on current Machine | Opened `/home/happier/mqa2-cont2-project` on `NLDW3-5-36-33 · 58f6`; the Project overview loaded and no `target_mismatch` occurred. | **PASS** |
| Different connected Codex profile | Selected the second ChatGPT connected account rather than the previously exhausted profile; it reported about 58–60% capacity. GPT 6 Luna and Low reasoning were selected. | **PASS** |
| Native approval, exactly one effect | Codex requested native approval for the exact `printf` command. One approval produced exactly one `mqa2-approved` line in the requested file, verified read-only on nl3. | **PASS** |
| Turn 2 and stop/resume | Turn 2 returned exact `TURN2_OK`. Stop reached Disconnected; Resume returned Ready with the prior transcript intact. | **PASS** |
| Agent Action matrix | The requested Action-only turn reported that no Happier Actions were available. A discriminating follow-up explicitly requested `action_spec_search`; Codex returned exact `ACTION_SPEC_SEARCH_UNAVAILABLE`. Settings set/reset, tab, script/output, operations, memory, dangerous deny/approve, live-only secret, and fresh summary therefore could not be exercised. | **BLOCKED — Happier Actions unavailable in live Codex session** |
| Terminal shell | Project → Terminal → New terminal opened a `Shell` tab with a terminal input. | **PASS** |
| MV12 capture-only pairs | Captured Home 1440 light, New Session 390 light, and post-Edit-tags rail 1440 dark at the required paths. No visual verdict or source change was made. | **PASS** |
| Daemon idle FD/CPU | Exact lane daemon PID `4025949`. The first 60 s window immediately after `hstack-exec` synchronization was `130..2192` FDs, average `204.18`, CPU `33.800%` of one core. The deciding window after 15 s warm-up was 61 samples over 60 s: `131..1766`, average `167.08`, zero samples at/above 2,000, CPU `28.433%` of one core. | **PASS for MFIX32's warmed no-~2,000-FD-burst discriminator** |

### Evidence and closeout

- Session `cmv6ere4400o6mczz2du3vk2m`; provider thread `01a13457-4448-7053-b325-5dd1512721c3`. The live Codex process was launched with the first-party Happier MCP server enabled, and its `happierMcpStdioBridge` child remained alive, so the Action failure is downstream of bridge injection rather than an omitted launch config. The available evidence did not isolate a safe canonical source correction; no speculative patch, test, or commit was made.
- Captures: `.happier/design-lab/lane12-final/live/mv12-home-composer-1440-light.png` (`1440x940`), `mv12-new-session-390-light.png` (`390x844`), and `mv12-rail-after-chip-click-1440-dark.png` (`1440x940`).
- No stack or daemon was restarted or stopped. The Account key was piped through stdin and never printed; no account secret or live-only secret value was disclosed.
- Adversarial check: the agent's first natural-language refusal alone could have been model error, so the exact tool-name follow-up and live process inspection were used to refute that alternative. An injected/running MCP bridge does not prove that Codex received a usable tool catalog, and the moving, heavily dirty CLI source prevents attributing the failure to a single current worktree hunk without further owner-level evidence. The warmed FD pass does not erase the immediate post-sync 2,192 peak; both windows are recorded.

Residual risk: the entire Action-dependent matrix remains unverified, including dangerous deny/approve, live-only secret handling, and fresh summary. Browser-side warmed Home/Projects/Action-detail timing was not requested by continuation 4 and was not repeated.

STATUS: BLOCKED

## Round 10b continuation 5

### Outcome

Round 10b continuation 5 independently disproved continuation 4's Agent-Action availability conclusion: the fresh Codex session exposed and executed Happier Actions. The matrix is nevertheless **BLOCKED** because several required effects were unreachable from the live fixture. The first settings read reproduced a canonical same-Account authorization defect; I added an owner-level RED test, fixed the single settings declaration owner, and proved focused GREEN without changing any surface appearance. The loaded daemon was not restarted, so the source repair could not be exercised live in this round.

### Runtime and scenario results

- Stack `agent-qa-l12-main` remained healthy and running. Selected/loaded server identity was `6218e64047961e65`; selected/loaded daemon identity was `f897e80afa954683`. One nl3 browser was used against borrowed UI port `19364`.
- Fresh Codex Session `cmv6hb0uo01tqmczz6p8s5oqc` ran on `NLDW3-5-36-33 · 58f6`, in Project `~/mqa2-cont2-project`, using the second connected ChatGPT Account, GPT 6.1 Sol, and Low reasoning.

| Required row | Independently observed result | Verdict |
| --- | --- | --- |
| Action availability | Visible `action_spec_search` calls returned the live Action catalog and subsequent Action tool calls executed. | **PASS — continuation 4 blocker cleared** |
| Settings set/reset | `settings.list` passed. `settings.get` for `appearance.atmospherePlanetDigits` returned `requester_account_material_unavailable`; no `settings.set` call or setting effect occurred, so reset was unreachable. | **FAIL — canonical defect fixed in source, loaded-runtime proof unavailable** |
| Tab open | `workspace.tabs.list`, `workspace.tabs.open`, then `workspace.tabs.list` produced exactly one new preview Session tab, id `82b823cd-37a2-4da5-9211-417eb3c30129`, targeting the current Session. | **PASS** |
| Script run/output open | `projects.list` returned complete coverage with `items: []`; no registered Action Project was available, so no script or output-open Action occurred. | **BLOCKED by fixture** |
| Operations | `action.operations.list` returned `invalid_parameters` because the attempted call omitted required `serverId` and `machineId`; no operation effect occurred. | **BLOCKED — required exact inputs not supplied by the live turn** |
| Memory | `memory.search` succeeded with `ok: true`, no hits, and no continuation. `memory.status` returned `invalid_parameters` without a required machine id; with no hit, `memory.get_window` was not reachable. | **PARTIAL** |
| Dangerous deny/approve | No qualifying dangerous Action reached an approval prompt. Plan mode subsequently prevented the agent from issuing mutation Actions. | **BLOCKED — no effect occurred** |
| Live-only secret | `notifications.webhooks.list` returned an empty list. No existing disposable channel was available; creating persistent infrastructure exceeded the authorized QA effect, so no secret-set call occurred. The live-only value was never entered, persisted, or disclosed. | **BLOCKED safely** |
| Fresh approval detail sentence | No fresh qualifying approval was created in this continuation. | **BLOCKED** |
| M15 Action-backed mode/goal | `session.mode.set` succeeded for `plan`; `session.goal.set` succeeded with objective `MQA2 parity verification`; `session.goal.get` confirmed active state. The loaded composer still showed `Set goal`, and opening it produced an empty editor. No visible mode chip/control could restore the default mode; plan-mode policy then refused Action mutations, including goal clear and mode reset. | **FAIL — Action state did not project into the composer; fixture remains in Plan with the QA goal active** |

### Functional repair and validation

- Canonical owner: `apps/cli/src/session/actions/settingsDeclarationAction.ts`. The enclosing executor already verifies the exact owner Session and selects the requester's Account credentials, but this owner treated every external execution authorization—including a same-Account Home authorization—as foreign material.
- The owner now accepts current credentials only when the authorization binding's Account id matches the Account id parsed from that credential. External public credentials, missing/unparseable credentials, and foreign-Account bindings continue to fail closed. Both machine-terminal-host and ordinary Account-setting paths use the same decision helper; no parallel settings owner was added.
- RED: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn exec -- vitest run --config vitest.g3-composed.config.ts src/session/actions/settingsDeclarationAction.test.ts` failed the new same-Account case, expected the default `true` value but received `requester_account_material_unavailable` (1 failed, 5 passed).
- GREEN: the same focused command passed 6/6 twice. The regression also proves a foreign current credential remains refused. The only mock is the external Account-settings HTTP boundary.
- The public CLI typecheck was retained on its original executor handle through repeated infrastructure retry windows, but never reached compiler output while shared dependency/publication locks stayed occupied. I interrupted only this lane's waiting validation client (exit 130); it is not claimed as passed. `git diff --check` passed for the three committed paths.
- No UI/style files changed. No stack or daemon was restarted or stopped. The Account key and all Account/live-only secrets remained undisclosed.

### Adversarial closeout and residual risk

- Alternative cause: visible tool payloads, not model narration, establish both the Action availability and the settings refusal. The same-Account regression fails before the owner change while the foreign-Account assertion stays closed, rejecting a blanket relaxation or a settings-value-specific explanation.
- Neighbor/blast-radius check: both settings branches share the corrected authorization decision; Home-scoped settings retain their separate scoped owner. No duplicate catalog, parser, or consumer workaround was introduced.
- Environment gap: selected and loaded runtime identities never changed, so the source fix is not live-certified. Script/output, operations, approval, live-only custody, and full memory-window behavior remain unverified. The stuck Plan/goal fixture and composer projection failure require owner-level follow-up; this source repair does not claim to fix them.

STATUS: BLOCKED

## Round 10b continuation 6

### Outcome

Round 10b continuation 6 is **BLOCKED by the required second connected Codex Account failing before it could execute an Action**. MFIX36's loaded mode projection/reset was independently observed, but goal projection and every remaining Action-dependent parity row could not be exercised. No product source or visual styling changed.

### Live evidence

- The loaded stack remained reachable with server identity `a07355a7077639c1` and daemon identity `92706f2d5f443a6c`; server health returned HTTP 200. No stack or daemon was restarted or stopped.
- The required Project was `~/mqa2-cont2-project` on `NLDW3-5-36-33 · 58f6`. The fresh composer independently showed the second connected ChatGPT Account, GPT 6.1 Sol, Low reasoning, and Default mode before launch.
- On existing Session `cmv6hb0uo01tqmczz6p8s5oqc`, the loaded composer visibly showed the `plan` chip. Clicking that chip and selecting Default removed the chip, independently proving the MFIX36 mode projection and UI reset effect rather than relying on Agent narration.
- The same Session could not execute the queued `session.goal.set`: Resume ended with `process-exited-before-webhook` before any Action call. Stack-owned exit records contained 15 occurrences of that exit class with code 1, including PID `1108151`; the UI remained at `Usage: 0% left`.
- After the prescribed retry interval, a clean draft again selected the second connected Account, GPT 6.1 Sol, Low reasoning, and `~/mqa2-cont2-project`. It created fresh Session `cmv6qcsae018omcyhj5lnwkpr`, but the Session had no messages, was immediately inactive, showed `Use CLI settings`, and rejected Send with `session_input_target_unavailable` before an Action could run.
- The browser target became unresponsive once while Chromium CDP remained healthy. A fresh product target was opened inside the same single browser process; the final retry above then reproduced the Agent failure. The browser owner was ended with SIGINT and CDP closure was independently confirmed.

### Scenario verdicts

| Required row | Independently observed result | Verdict |
| --- | --- | --- |
| MFIX36 mode projection/reset | Plan chip visible on the loaded Session; UI reset removed it. | **PASS** |
| MFIX36 goal set/projection and in-plan goal clear/reset | No Action executed after reload; the old queued turn and fresh Session both lost their Agent input target. | **BLOCKED** |
| Plan-mode mutation policy | No post-reload Agent turn ran, so allowed clear/reset and refused unrelated mutation could not be discriminated. | **BLOCKED** |
| `projects.list` coverage | The required Agent could not issue the Action. | **BLOCKED** |
| Settings get/set/reset | The required Agent could not issue the Actions; MFIX36 live certification therefore did not cover the continuation-5 settings repair. | **BLOCKED** |
| Registered Project script run/output open | No Action execution or approval target was reachable. | **BLOCKED** |
| Exact server/machine operations | No Action execution was reachable. | **BLOCKED** |
| Memory status/window | No Action execution was reachable. | **BLOCKED** |
| Dangerous deny/approve and fresh plain summary | No approval was created; zero dangerous effects occurred. | **BLOCKED safely** |
| Existing disposable live-only secret channel | Availability could not be re-read independently; no secret value was entered, persisted, or displayed. | **BLOCKED safely** |

### Adversarial closeout and residual risk

- Alternative cause checked: the first reconnect/browser-target problem was not treated as the Agent blocker. After a full retry interval and recovery within the same browser process, a clean second-account Session independently reproduced an unavailable input target, while the server stayed reachable.
- Hypothesis limit: the safe exit metadata proves repeated pre-webhook termination, but does not identify whether Account capacity, Codex runtime startup, or Happier launch integration caused code 1. Treating it as a canonical Happier defect would be speculation, so no RED test or source patch was manufactured.
- No focused test, package check, or commit was applicable because no production file changed. The only local addition is this QA evidence in the already shared, pre-dirty tracker.

Residual risk is every blocked row above, especially goal projection/clear, the continuation-5 settings repair in loaded runtime, script/output, operations, memory window, and approval denial/approval. Resume only with a second connected Codex Account that can keep a fresh Session alive through its first webhook.

STATUS: BLOCKED

## Round 10b continuation 7

### Outcome

Round 10b continuation 7 is **BLOCKED by the known Claude first-turn non-termination**. A genuine connected Claude/Sonnet 5/Low first turn reached Happier Actions, but the turn never terminated; the next fresh group remained queued even after its visible `Send now` confirmation. No product source, test, or visual styling changed.

### Live evidence

- The loaded `agent-qa-l12-main` stack remained healthy on nl3 with selected/loaded server `2bf21d8b711910ab` and daemon `66460a6f1c4ce1f2`. The independently observed Home id was `srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN`; the only reachable machine was `NLDW3-5-36-33 · 58f6`, full id `58f6e63a-cd69-4302-83f1-325d10da7ec3`.
- Fresh Session `cmv6xbm0l01vjmcrqc0ykhy3s` used the connected Claude profile, Sonnet 5, Low reasoning, and `~/mqa2-cont2-project`. Visible Action-result payloads independently returned `unsupported_action` for `session.goal.set`, `session.goal.get`, and `session.mode.set`; neither a goal nor mode chip appeared. Its subsequent `projects.list` call remained pending and the first turn never reached a terminal state.
- Source tracing found one Action executor owner, not a duplicate: the UI supplies goal dependencies in `defaultActionExecutor.ts`; protocol returns `unsupported_action` when those dependencies decline the operation; CLI routing delegates to the Session goal-control RPC; and Claude advertises native goal controls only when its runtime supplies both operations. The connected Claude runtime did not advertise those controls. No evidence established that manufacturing non-native goal state would satisfy the provider contract, so no speculative source change was made.
- Fresh settings-group Session `cmv6xqfw4022zmcrqxn1xocu6` was created with one first-turn prompt. Its prompt remained visibly queued behind the non-terminating run; confirming `Send now` did not start an Action. Per the continuation instruction, the blocked lifecycle was recorded rather than chased, and later independent groups were not started because they would exercise the same blocked queue rather than their requested effects.

### Scenario verdicts

| Required row | Independently observed result | Verdict |
| --- | --- | --- |
| MFIX36 goal projection and clear | Goal set/get both returned `unsupported_action`; no goal chip appeared. | **BLOCKED by connected-Claude capability** |
| MFIX36 mode set/reset and plan policy | Mode set returned `unsupported_action`; no mode transition occurred. | **BLOCKED by connected-Claude capability** |
| `projects.list` | The Action started but never produced a result before the turn stalled. | **BLOCKED by turn non-termination** |
| Settings get/set/reset | Fresh Session created; its sole prompt remained queued after `Send now`. No setting effect occurred. | **BLOCKED safely** |
| Script run/output, exact operations, memory status/window | Not started after the common fresh-turn lifecycle blocker was proven. | **BLOCKED** |
| Dangerous deny/approve and fresh one-sentence detail | No approval was created and zero dangerous effects occurred. | **BLOCKED safely** |
| Existing disposable live-only channel | Not reached; no secret value was entered, persisted, or displayed. | **BLOCKED safely** |

### Adversarial closeout and residual risk

- Alternative causes checked: Action availability itself was not the blocker—the first Session produced real Action payloads. The second Session and its queued prompt prove the remaining groups were blocked before their Actions, while the stack and machine stayed reachable.
- The unsupported goal/mode results were checked against current owner wiring and Claude capability publication. Without evidence that the connected runtime supports native controls, treating those results as an owner defect would risk creating a second Session-state authority.
- No focused test or commit was applicable because no production behavior changed. The stack was neither restarted nor stopped. The sole browser owner was ended after this evidence and its CDP endpoint was checked closed.

Residual risk is all blocked rows above. Resume with the Claude turn-termination/queue defect repaired or with a connected Claude runtime that can complete each fresh first turn and advertise the required native goal/mode controls.

STATUS: BLOCKED

## Round 10b continuation 8

STATUS: RUNNING

### Outcome

TURNEND is a **PASS** for the observed connected Claude flow: fresh Session `cmv7dxwku00lxmcvkajcug3a7` completed `FIRST_OK`, accepted a follow-up, completed `SECOND_OK` as a distinct turn, and returned to Ready. The full Agent-parity matrix is **BLOCKED** because the actual lane daemon and every spawned Session runner use an older source bundle that lacks both required corrections, while several Action results were not independently observable. No product source or visual styling changed.

### Runtime identity and loaded-byte check

- Stack info continued to report healthy selected/loaded server `4db709539a3ff96a` and daemon `66460a6f1c4ce1f2`, with Home `srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN` and Machine `NLDW3-5-36-33 · 58f6` (`58f6e63a-cd69-4302-83f1-325d10da7ec3`).
- The live lane daemon was independently resolved from the remote runtime state and `/proc`: PID `1448392`, launched from source bundle `runtime-afc18c20e2923df4dd7fb3392eeb8dd311952cfa9eec6e0a09da8b7d993cbb86-lbxxAE` (built 2026-10-13 18:11 CEST). Every fresh Claude runner observed in this round used that same bundle.
- The actual `runtime-afc…` compiled bytes have `stageSessionStateMutation` but not MFIX37's adjacent `stageWorkStateMutation` binding in `createHappierMcpServer`, and contain no `session_turn_mutation_rejected` TURNEND journaling path. This disproves the control-plane selected/loaded label as evidence that the required code is loaded.
- A different nl3 stack's newer bundle, `runtime-fdad4bb…` (built 2026-10-14 02:07 CEST), contains both the MFIX37 binding and the TURNEND rejection-journaling code, but it is not the `agent-qa-l12-main` daemon or Session runtime and was not used as QA evidence.

### Scenario results

| Required row | Independently observed result | Verdict |
| --- | --- | --- |
| TURNEND first turn + next turn | `FIRST_OK` completed; `SECOND_OK` started and completed as a distinct follow-up; Session returned to Ready. | **PASS** |
| Goal set → composer → clear | In fresh Session `cmv7e4uaj00ocmcvk91wek4x3`, two visible native goal-set results returned `inactive_agent_runtime_unavailable`; the composer remained `Set goal`, so clear was not a valid follow-up. | **FAIL on stale loaded bundle** |
| Mode | `session.mode.set` returned success for `plan`; the composer independently displayed the `Plan` chip. | **PASS** |
| `projects.list` | In Session `cmv7f0s3y00utmcvkwumvr16g`, a visible `action_execute` card invoked `projects.list` with `{}` and the turn completed. The card exposed input but no output; the model narrated an external-authorization refusal, which was not accepted as independent evidence. | **BLOCKED — result not observable** |
| Settings get/set/reset | Fresh Session `cmv7eofz500ssmcvkadp9v987` started after delayed queue admission. The agent attempted an unrequested terminal lookup instead of the named Actions; that approval was denied and the provider turn then failed. No setting mutation occurred. | **BLOCKED safely** |
| Script run + output open | Fresh Session `cmv7f0s3y00utmcvkwumvr16g` took 152 seconds to spawn and needed repeated `Send now` confirmation before its turn started. Because the prerequisite `projects.list` result was not observable, no script run or output-open Action followed. | **BLOCKED by Project-list result** |
| Exact operations + memory status/window | After the required delayed retry, fresh Session `cmv7fq8lm00yemcvk2y52t164` admitted the queued prompt and completed. Two visible `action_execute` cards independently proved Action invocation, including `action.operations.list` with the exact Home and Machine ids; their detail panels exposed inputs but no result payload, and no independently observable `memory.get_window` call followed. The model's narrated error was not accepted as evidence. | **BLOCKED — results not observable** |
| Dangerous deny/approve + plain detail | The unrequested terminal lookup was denied and had no effect, but no qualifying requested dangerous Action was approved and no fresh Action approval detail was available. | **PARTIAL deny only; approve/detail BLOCKED** |
| Existing disposable live-only channel | No disposable channel was established in this continuation; no live-only value was entered, persisted, or disclosed. | **NOT APPLICABLE safely** |

### Defect adjudication and residual risk

- The observed goal failure does not justify a new product patch against current source: MFIX37 already corrects the missing MCP composition sink, and the exact live runner bytes predate it. Patching the current router or inactive adapter would create a second response to a deployment mismatch rather than fix the loaded owner.
- Independent current-source validation passed: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn exec -- vitest run --config vitest.g3-composed.config.ts src/mcp/createHappierMcpServer.goalParity.test.ts` completed 1/1 green and exercised the real Claude goal Action through the durable work-state owner.
- The settings turn shows model/tool-choice failure plus provider failure, not a settings-owner reproduction. Fresh-session admission was severely delayed but recovered on the mandated retry while the stack control plane and daemon process remained alive; its cause was not proven, so no speculative test or source fix was added.
- The stale `Send now` affordance once surfaced a 404 after the follow-up had already started. The successful second turn disproves it as a TURNEND failure; it remains an adjacent UI race candidate, not an independently reproduced functional defect in this round.
- Required reload/restart authority was explicitly withheld, so the stale lane runtime cannot be replaced here. Operations, memory, requested dangerous approval/effect, approval-detail copy, and script/output remain unverified.
- The sole browser owner was ended with SIGINT after QA. Both a direct CDP request and the browser session lookup then failed with connection refused; the stack was neither restarted nor stopped.

STATUS: BLOCKED
