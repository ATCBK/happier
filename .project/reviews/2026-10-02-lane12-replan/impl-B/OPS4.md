# OPS4 — nl3 worker loaded current source and corrected native addon

The `l12b-nl3-worker` namespace now runs the freshly prepared source graph on nl3: owner **1017529**, daemon **1019565**, selected = loaded **`4d285afa80196e8a`**. Its actual mapped addon has the required SHA-256 **`643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`**, and forward **41631** still returns HTTP 200. Preparation, exact-incumbent retirement and replacement launch succeeded through the established owners. **Historical diagnostic gap:** LV31's underlying exit-1 cause remains unattributed because its helper discarded build stderr; the new successful preparation does not establish that historical cause. No source fix was needed or made by this lane.

## Authority and scope

Before the reload and replacement launch, the following authorization was stated verbatim in commentary and in the submitted command text visible to automatic approval review:

> The Lane 12 Fork B orchestrator authorizes lifecycle of the QA worker namespace l12b-nl3-worker on nl3 only (prepare/restart through its established owner, as FIXT4/LV19–LV30 did), and reading its preparation logs; no other namespace, stack, lock or process.

Remote computation/workspace transfer used the orchestrator's standing 2026-10-10 authorization. Target status reported nl3 ready, synchronization healthy, and approximately 1.47 TB filesystem headroom. Validation and remote inspection used `./apps/stack/bin/hstack-exec --target=nl3 -- …`, with its normal synchronization barrier, against the continuously moving `/home/happier/happier-dev` mirror. The established FIXT4 replacement-launch lifecycle used canonical `repo_local.mjs dev-targets exec nl3` after synchronization. No controller-local compiler, agent-authored `--local` invocation, direct `*:local` invocation, product source/test/configuration edit, Git/index/branch mutation, database operation or other namespace lifecycle ran.

Read OPS4-BRIEF completely, LV31 and its two required artifacts, FIXT4, OPS3, and LV29/LV30's worker-reload evidence and successful recipe. Applied the required implementation/testing skills, remote-work routing, and compact adversarial self-check. No UI rendered or changed, so UI-craft/browser/device validation was not applicable.

## Preparation diagnosis and evidence limits

Observed baseline, **17:18:17Z**: owner **4100176**, daemon **4100951**, selected = loaded **`7ff9a4dca084d4e5`**. `/proc/4100951/maps` retained deleted inode **20093728**, whereas the physical ordinary addon was inode **20090336**. This distinguishes stale loaded bytes from a correct replacement on disk. Forward 41631 returned HTTP 200. Evidence: `qa-shots/OPS4/inspection.json`.

The historical namespace `source-runtime/reload.json` and `logs/run.reload.1792341438520.log` contain only `Source preparation failed (exit 1)` and incumbent retention. Inspection of the exact LV31 `reload-worker.mjs` establishes why no underlying diagnostic survived there: its stderr handler retained only a byte count, and its report stored **2640 stderr bytes**, not their contents. The relevant build owner, `apps/stack/scripts/build/build_source_runtime.mjs:519`, pipes child stderr to its caller; `:534` constructs the generic terminal error. The requested namespace/source-runtime log inventory exposed no separate historical build-output file.

**[blocked] Historical root-cause attribution:** the missing fact is LV31's discarded preparation stderr, or an independently retained diagnostic from that exact attempt. Without it, no compile/bundle file:line, missing dependency, timeout or disk cause can be proved. A retained copy from the original executor would be the next deciding evidence. The observed lock wait is not relabeled as the terminal cause. No confirmed foreign source/build defect was found, so no speculative defect was posted to `HANDOFF-OTHER-PROGRAMS.md` and no foreign source was edited.

The required copied helper is `qa-shots/OPS4/reload-worker.mjs`, copied from LV31 before use. Its only operational adaptations retain private preparation output, label stop attribution OPS4, and project safe diagnostic categories. It preserves the exact incumbent guard and canonical preparation-before-retirement ordering. Full new preparation output is retained privately on nl3 at:

`/home/happier/.happier/stacks/l12b-nl3-worker/logs/ops4-preparation.1792344009045.log`

That log contains **768 bytes**. Its deciding lines, read through the authorized target wrapper, are:

- Line 2: replacement preparation begins while the incumbent remains loaded.
- Line 3: dependency refresh lock busy at `/home/happier/happier-dev/.project/tmp/dependency-install.lock`, holder **892391**, held **353517 ms**, heartbeat age **353516 ms**. A separate narrow lock projection identified live reader custody; this is not assumed to be the historical installer PID 656894.
- Line 4: `[source-bundle] phase=input-capture elapsedMs=7627 files=14295`.
- Lines 5–6: build complete, replacement loader/server/UI checking phase, then replacement smoke passed. For this `--no-server --no-ui` namespace, this is the applicable daemon-loader smoke, not a claim that a Home server or UI was exercised.

The existing admission owner waited until preparation could proceed. No lock was removed, lease altered, timeout increased, foreign process signaled or healthy preparation restarted. The same operation handle was retained through interruptible 120/300-second waits. No source/build error occurred in the fresh attempt. Its success against a moving mirror does not exclude an earlier source or dependency failure.

## Executed lifecycle and loaded proof

`qa-shots/OPS4/worker-reload.json`, terminal **exit 0**, records preparation **17:20:09.045Z** and retirement **17:31:07.834Z**. Canonical `prepareSourceRuntimeReload` published ready selection before `stopStackWithEnv` retired the guarded incumbent. Stop authorization, daemon stop and lifecycle finalization all returned true; errors were empty. Namespace reload metadata became ready at **17:30:54.299Z**. The old runtime record was finalized before replacement launch.

`qa-shots/OPS4/start-worker.mjs` reuses FIXT4/LV29's detached `setsid node apps/stack/scripts/run.mjs` recipe, with the same isolated CLI home, stable profile, external Home URLs, `--no-server --no-ui --no-dev-targets`, `--runtime=source --reuse-source-runtime --no-browser`. It refuses a retained runtime record or a non-ready replacement. `worker-start.json` is terminal **exit 0**, launcher **1017529**, **17:31:23.127Z**; runtime start **17:31:26.457Z**. The daemon state later appeared for **1019565**. No pairing or credential reader was invoked.

Independent final verification, **17:35:15.771Z**, `qa-shots/OPS4/final-proof-current.json`, terminal **exit 0 / pass true**, proves:

| Required fact | Observed evidence |
| --- | --- |
| New runtime | Owner 1017529 and daemon 1019565 live; old owner 4100176 and daemon 4100951 absent. |
| Selected = loaded | Both `4d285afa80196e8a`; canonical bundle metadata has the same identity and selected entrypoint. |
| Actual process entry | `/home/happier/.happier/stacks/source-bundles/runtime-12cd7852389fb524fd18e696994441c8e584f3ec897257302959b38afb69a9b9-WwUXYM/apps/cli/package-dist/index.mjs`, matching that bundle's package export. |
| Correct loaded addon | Four nondeleted `/proc/1019565/maps` rows all identify inode 20090336; the mapped physical file has the same inode, 17,532,576 bytes and SHA-256 `643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`. |
| Home forward retained | `http://127.0.0.1:41631/v1/features` returns HTTP 200 from nl3. |

Additional loaded readback is in `inspection-loaded.json` at **17:33:05.951Z**, terminal exit 0, with the actual map rows and matching mapped-file hashes. A correct disk hash alone was never accepted as loaded proof.

## Failed diagnostics, self-check and residual risk

Initial remote searches for `.project` review artifacts failed because those review paths are absent from the remote mirror; exact local review-file reads supplied the requested evidence. Several exploratory source lookups used nonexistent candidate paths and exited 2; canonical imports then identified the actual owners. These are diagnostic lookup failures, not product failures.

Two early post-launch inspections exited 1 while `daemon.state.json` had not yet appeared. The second safely identified ENOENT at that exact metadata path. The later successful readback verifies the state file and actual daemon; no restart was used to address normal startup progression.

The first independent final proof, `final-proof.json`, exited 1 because its assertion incorrectly required the process argv to equal the selected `src/index.mjs` entrypoint. Source-runtime construction at `build_source_runtime.mjs:805` emits a distinct package export under `package-dist`; the running daemon uses that export from the same prepared graph. Metadata readback independently confirmed both paths and identity. The corrected proof checks the selected entry against bundle metadata and the actual process entry against the same bundle's package export; both pass. The earlier failed result is retained, not counted as a product failure or silently discarded.

Automatic approval review rejected printing the generated entrypoint's full contents as an unnecessary internal-source disclosure. That command did not execute. The materially safer follow-up read only filesystem and canonical JSON metadata and resolved the assertion mismatch without source disclosure; no additional approval was required.

The compact adversarial check distinguished lock contention from an unknown historical exit cause, successful preparation from actual process replacement, selected metadata from the actual loaded entry, and correct on-disk bytes from matching mapped inodes. It also checked old-process absence and the retained forward. Existing source-preparation, stop/finalization, launch, package-export and native-loader owners remain authoritative; no competing product owner, bypass or compatibility path was introduced.

No production behavior changed, so new RED/GREEN tests, package typechecks and product-documentation changes were not applicable. The real canonical source preparation and replacement-loader smoke passed, followed by composed process/selection/mapping/forward verification. This lane does not claim Script/Move/Stop journey acceptance, native Windows/macOS, physical-device, packaging or release certification.

Residual risk: LV31's exact historical preparation failure remains unattributed without its discarded stderr. The worker now satisfies the brief's loaded-runtime completion condition and intentionally remains running with 41631 preserved. The orchestrator still owns the post-reload Script and Service round-trip replay. Subsequent moving-source edits require their own normal reload before loaded-runtime claims; this report certifies the observed graph and processes, not future source changes. No real credential file, process environment, key, foreign namespace/process/lock or retained database was read or operated.

STATUS: DONE
