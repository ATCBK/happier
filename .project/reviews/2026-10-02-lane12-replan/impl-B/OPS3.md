# OPS3 — FX129 ordinary addon prepared on every named QA consumer host

Completed artifact preparation on **nl2, nl1 and nl3**. All three deterministic ordinary addon paths now contain **17,532,576 bytes**, SHA-256 **`643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`**. Canonical native builds, load/lifecycle smokes, applied transport-configuration tests and selected real-binding regressions passed on nl1/nl3. **RELOAD NEEDED — orchestrator only: QA Home server `agent-qa-l12-b` on nl2, SOURCE daemon on nl1, and worker namespace `l12b-nl3-worker` on nl3.** No runtime was restarted, reloaded, signaled or killed. The loaded QA correction and post-restart journey remain unverified by design; nl2 native smoke was not executed locally. One initial source lookup used an incorrect preparation-script path and exited 2; the actual owner was found and read. No build/test failure or new unattributed runtime failure was observed.

## Canonical owner and actual pickup path

Observed source and runtime evidence independently re-derive OPS2's materialization contract:

- `packages/iroh-native/scripts/build-node-addon.mjs` owns the ordinary pinned Cargo build: `--locked`, release, `x86_64-unknown-linux-gnu`, without `--test-relay-fixture`. Its normal output is `native/happier-iroh-native-lifecycle.linux-x64.node`; the separate `native-test/` binary is not an input to these QA runtimes.
- `apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs:21` calls the existing source-bundle preparation owner. `apps/stack/scripts/build/build_source_runtime.mjs:789` retains the execution host's physical `packages/iroh-native/src/nodeNative.ts` URL in the emitted loader. `packages/iroh-native/src/nodeNative.ts:108` resolves that physical package root, and `:144` selects its deterministic ordinary `native/` artifact.
- Inspection of both preparation/build owners found no Iroh-addon build or copy into source bundles. Preparation **reuses the prebuilt binary at the physical source root**. Its process-custody native build is a separate tool, not an Iroh rebuild. Preparing TypeScript alone cannot replace an already loaded addon.
- The actual loaded server/daemon chunks on all three hosts contain their respective physical source URL, listed below. This verifies the running consumer's locator rather than inferring it solely from present source.
- FX129's canonical transport owner, `packages/iroh-native/rust/happier-iroh-core/src/limits.rs:32`, no longer applies `max_idle_timeout(None)` and retains the dependency's liveness defaults. FX122's `packages/iroh-native/rust/happier-iroh-node/src/lib.rs:79`, `run_lifecycle_operation`, remains. Both fresh release builds compiled these real crates; both installed binaries expose demangled `run_lifecycle_operation` / Tokio `BlockingTask` symbols. The applied-config test passed independently on both hosts.

No additional loader, timeout owner, runtime registry, compatibility path, source selection or native-specific flag was introduced. All relevant production source/test hunks were left as found. This ops lane materializes the existing correction; it does not claim a new source change or manufacture another RED. FX129 owns the original behavior-change RED/GREEN and composed abrupt-process-retirement proof.

## Safety and exact materialization recipe

The builder currently removes its selected output then copies the Cargo library; it has no output-directory option. To meet the brief's stronger atomic-install requirement, `/tmp/happier-ops3-host.mjs` ran an **unchanged copy of the canonical builder** from a fresh ignored staging package root under `packages/iroh-native/native/.ops3-staging-*`, with `rust` symlinked to the real Rust workspace and `CARGO_TARGET_DIR` set to the real cached `packages/iroh-native/rust/target`. Thus the builder's remove/copy touched only a staging filename. After a successful ordinary build, the helper verified the destination had not concurrently changed, then used **`renameSync(stagedArtifact, ordinaryArtifact)` on the same filesystem**. No loaded `.node` inode was truncated, overwritten or temporarily removed.

On each remote host, `ensure-rust-toolchain.mjs --platform host` reported pinned **Rust 1.94.1 already ready**; no installation was needed. The script copy changes only the output location and uses the existing build logic and real source workspace. Staging roots were nl1 `native/.ops3-staging-1wIClw` and nl3 `native/.ops3-staging-DsPMQq`.

nl2 repeated OPS2's canonical synchronized transport: `/tmp/happier-ops3-materialize.mjs` invoked `hstack-exec --target=nl3 -- node ...` to capture only the ordinary artifact as base64, kept binary contents out of chat, verified the expected SHA-256, wrote an exclusive temporary sibling and atomically renamed it onto the ordinary destination. It required the previously inspected destination hash/inode to remain unchanged before installation, then checked installed bytes, new inode, process start ticks, mappings and stack identity. No controller-local compiler or native validation process ran.

## Per-host delivery and preserved runtimes

All paths below refer to the ordinary Linux x64 addon. **Each final installed hash is `643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`.** Final readbacks ran at **2026-10-18 15:12:13–15Z** after all tests.

### nl2 — QA Home server, `agent-qa-l12-b`

- Source/package root: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native`.
- Installed artifact: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`. Delivered from the independently built and verified nl3 ordinary artifact; no local Cargo output was produced.
- Disk inode changed **91564709 → 91572361**; previous hash was `da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`.
- State: `/home/leeroy.guest/.happier/stacks/agent-qa-l12-b/stack.runtime.json`. Owner **3252939**, server **3262149**, start **14:54:26.216Z**, server selected/loaded **`7d0181b76eb565cb`**. Server start tick **76279370** and owner start tick **76278439** remained unchanged.
- Actual loaded entry: `/home/leeroy.guest/.happier/stacks/source-bundles/runtime-1d3ab1a6115b813a6380c564f47a4e1d735d8f19c9d9f3ba7492dd138df13a80-01XIzQ/apps/server/sources/main.mjs`. Its `apps/server/src/chunks/chunk-P2S6OIVM.js` contains `file:///home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/src/nodeNative.ts`.
- The server had **no Iroh addon mapping** before delivery or at final readback. It remained alive with the same identity; there was no mapped local addon inode to preserve. Delivery proof is exact binary identity with both remote tested artifacts, not a local native smoke.
- Derived pickup: the next Home process/preparation uses this physical package's ordinary artifact. **Reload the Home server through its existing owner; no native flag, package-root override or bundle-sidecar copy is required.**

### nl1 — SOURCE Machine `d06f323d-88fa-4491-bc40-aebac4734bd6`

- Source/package root: `/home/happier/happier-dev/packages/iroh-native`.
- Cargo artifact: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.
- Installed artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`.
- Disk inode changed **20587923 → 20590573**; previous hash was `da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`.
- State: `/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/stack.runtime.json`. Owner **1859610**, daemon **1862043**, start **14:54:55.742Z**, daemon selected/loaded **`2c9ab931358f386f`**. Daemon start tick **77088030** and owner start tick **77086355** remained unchanged.
- Actual loaded entry: `/home/happier/.happier/dev-targets/nl1/stack-state/source-bundles/runtime-f4e9de72983fd14f34049123f7c11364ad0eecfdb69193a73f611ba2f6c91106-fMZjZJ/apps/cli/package-dist/index.mjs`. Its `apps/cli/src/chunks/chunk-PFFBUA3J.js` contains `file:///home/happier/happier-dev/packages/iroh-native/src/nodeNative.ts`.
- `/proc/1862043/maps` retained the same four ranges, permissions, offsets and old inode **20587923** after installation; the path acquired **`(deleted)`**. The original daemon remained alive at final readback and did not map the new disk inode.
- Derived pickup: recreate SOURCE through its established dev-target stack owner to load the corrected artifact. **No additional native flag or source-selection mutation is required.** The current PIDs above supersede historical FX129/OPS2 observations; do not use old teardown identities.

### nl3 — worker namespace `l12b-nl3-worker`, Machine `444aa1ca-1a63-4dd6-93e4-9b34bb8c72d8`

- Source/package root: `/home/happier/happier-dev/packages/iroh-native`.
- Cargo artifact: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.
- Installed artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`.
- Disk inode changed **20093804 → 20090336**. The prior disk artifact was FX129's source-validation build, hash `f6e8ce42c9e32871215f3671e98a203a57ecc1f8f4927009529cb9d38cf7e2d7`, 17,532,528 bytes. This lane performed a fresh canonical ordinary build and verified its installed bytes; it does not equate either disk artifact with the loaded worker.
- State: `/home/happier/.happier/stacks/l12b-nl3-worker/stack.runtime.json`. Owner **4100176**, daemon **4100951**, start **14:03:13.832Z**, selected/loaded **`7ff9a4dca084d4e5`**. Daemon start tick **52344202** and owner start tick **52343361** remained unchanged.
- Actual loaded entry: `/home/happier/.happier/stacks/source-bundles/runtime-dde71347c8e6392cc68bd1592207d3ade8da4736a89b80a2c74fbb61b778817f-bkhcPe/apps/cli/package-dist/index.mjs`. Its `apps/cli/src/chunks/chunk-PETREP4B.js` contains `file:///home/happier/happier-dev/packages/iroh-native/src/nodeNative.ts`.
- `/proc/4100951/maps` retained the same four ranges, permissions, offsets and previously unlinked inode **20093728**, with **`(deleted)`**, before and after the build and at final readback. The original worker remained alive and did not map the new disk inode.
- Derived pickup: the established namespace process launch, including its existing `--runtime=source --reuse-source-runtime` recipe, resolves the new ordinary artifact at this physical source root. **No new native flag is required.** Preserve worker custody and forward **41631**; only the orchestrator may retire/recreate this namespace.

## Executed validation and reproducible commands

All native builds, source searches and executed product tests/smokes used synchronized **`./apps/stack/bin/hstack-exec --target=nl1|nl3 -- ...`** against continuously moving `/home/happier/happier-dev` mirrors. The brief explicitly supplies remote-compute/workspace-transfer authority under the user's standing **2026-10-10 authorization**. Both canonical target status checks reported ready, and every launch performed its normal prelaunch synchronization. No `--local`, direct `*:local`, controller compilation, release packaging or QA lifecycle command ran. Local work was limited to exact report/source reads, read-only machine-local process evidence and the authorized atomic binary delivery.

| Check | nl1 terminal evidence | nl3 terminal evidence |
| --- | --- | --- |
| Pinned preparation + staged ordinary canonical release build + atomic install + dispatch symbols + `verify-node-addon-load.mjs` | **79979**, exit **0**; Cargo **8.77 s**; Node **24.21.0**, load **1.703 ms**, endpoint **12.454 ms** | **61686**, exit **0**; Cargo **7.25 s**; Node **24.21.0**, load **1.688 ms**, endpoint **14.856 ms** |
| Applied transport-config owner test | **33632**, exit **0**; **1 passed / 80 filtered** | **93633**, exit **0**; **1 passed / 80 filtered** |
| Real loader → typed module → ordinary NAPI/native lifecycle, selected FX122 and healthy-idle neighbors | same **33632**, exit **0**; **2 passed / 7 filtered**, retired-peer **3021 ms**, idle/shared-lease **35073 ms** | same **93633**, exit **0**; **2 passed / 7 filtered**, retired-peer **3018 ms**, idle/shared-lease **35050 ms** |
| Final artifact + unchanged runtime/mappings readback | **55616**, exit **0**, **15:12:13.025Z** | **31073**, exit **0**, **15:12:14.876Z** |

nl2 delivery: **5823**, exit **0**, **15:10:04.381Z**, exact transferred/installed hash and new inode checked; final local readback **15:12:15.270Z**. No binary base64 was printed into the conversation.

Focused test commands on each remote host, with that user's existing Cargo bin prepended to PATH:

```sh
cargo test --locked --manifest-path packages/iroh-native/rust/Cargo.toml \
  -p happier-iroh-core profiles_bound_only_real_per_connection_resources
env UV_THREADPOOL_SIZE=4 HAPPIER_IROH_REQUIRE_NODE_ADDON=1 \
  node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  packages/iroh-native/src/nodeNativeLifecycle.test.ts \
  -t 'retired-peer dials|serves two tunnel leases' --maxWorkers=1 --reporter=verbose
node packages/iroh-native/scripts/verify-node-addon-load.mjs
```

The real-binding checks use the installed ordinary addon and no mocked internal logic. They establish the real producer/consumer path, healthy idle byte movement, sibling lease continuity and native shutdown within their own fixture lifecycles. Nonmatching tests are filtered, not claimed as run. The abrupt-native-process-restart integration was not rerun in this ops lane; its prior FX129 report is context, not fresh OPS3 execution evidence. No production/test source changed, so no additional package typecheck was warranted for artifact materialization. FX129's reported CLI typecheck/formatting limitations are not cleared by this report.

## Reload handoff and residual risk

**RELOAD NEEDED:** the orchestrator must reload/recreate the QA Home server, nl1 SOURCE daemon and nl3 namespace worker through their existing owners after LV30 releases the current runtimes. A JavaScript preparation alone does not activate a native replacement. None needs a new native flag. Then verify the new processes map the new artifact and run FX129's composed post-worker-restart recipe: SOURCE stays up; recreate the owned worker; replay fresh UI-approved qaW `ok`/`fail` and SOURCE→nl3→SOURCE Service Move→normal Stop, joining settled flushes with native exits **0/17**, fresh bytes, final placement and native absence. Preserve namespace custody and forward 41631.

The compact adversarial check explicitly falsified two misleading completion claims: the loaded chunks prove that source preparation reaches the physical package rather than an imagined bundle-sidecar copy; preserved old mapped inodes prove that a correct disk hash is not loaded-runtime activation. The applied-config test checks the actual upstream liveness fields, while the 35-second real tunnel test covers healthy inactivity beside dead-peer handling. Final process start ticks, source identities and mappings match the pre-install observations. Those observations establish preservation of the running processes, not an independent authenticated health or LV30 acceptance claim.

No credential reader, access key, account-recovery key, retained database, Git index/branch, unrelated source hunk, Windows namespace, QA forward or foreign process was changed. Reviewed TRACKING's prior windows1-linux Rust installation/build notes; that historical second worker is outside this brief's three named consumers and was left untouched. The only repository-authored content is this requested report; other writes are ignored native build outputs and lane helpers under `/tmp`.

Residual risk: corrected artifacts are ready for the next existing-owner reload, but the current daemons deliberately retain old native bytes and the Home server has not exercised native initialization. Post-reload Scripts/Move/Stop remain the orchestrator's live gate. nl2 has exact hash provenance rather than an executed local native smoke. Native Windows/macOS, mobile, browser WASM, packaging and release validation were not run and are not certified here.
STATUS: DONE
