# OPS2 — corrected ordinary Iroh addon materialized for all QA consumers

Completed the artifact-preparation assignment: all three consumer paths now contain the corrected ordinary Linux x64 addon, SHA-256 **`da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`**, **17,532,576 bytes**. nl1 and nl3 canonical native builds, FX122 regression tests, and lifecycle smokes exit 0. nl2 received the identical nl3-built artifact through the synchronized execution transport; no controller-local compilation or native smoke was run. **RELOAD NEEDED: QA Home server on nl2, SOURCE daemon on nl1, and namespace `l12b-nl3-worker` on nl3.** None was restarted, reloaded, signaled, stopped, or killed by this lane.

## Canonical artifact and preparation owners

Observed current source:

- `packages/iroh-native/scripts/build-node-addon.mjs` invokes pinned Cargo with `--locked`, ordinary `release`, target `x86_64-unknown-linux-gnu`; it copies `packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so` into `packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`. Neither build used `--test-relay-fixture`; `native-test/` is not a QA runtime input.
- `apps/stack/scripts/build/build_source_runtime.mjs:787` retains the execution host's physical `packages/iroh-native/src/nodeNative.ts` URL in the emitted loader. `packages/iroh-native/src/nodeNative.ts:108` resolves that package root and `:144` chooses its deterministic `native/` filename. `prepareSourceRuntimeReload.mjs:21` prepares/adopts source bundles through that builder. **This path reuses the prebuilt ordinary addon at its physical host source path; it neither copies that addon into the source bundle nor invokes the Rust addon builder.** Updating TypeScript or preparing a new source bundle alone does not rebuild it.
- FX122's corrected NAPI owner is `packages/iroh-native/rust/happier-iroh-node/src/lib.rs:79`, `run_lifecycle_operation`, dispatching through the existing native runtime. Both rebuilt binaries expose demangled native symbols containing that owner and `tokio::runtime::blocking::task::BlockingTask`. No second loader, dispatch owner, runtime registry, or compatibility path was introduced by OPS2.

## Per-host delivery and runtime evidence

### nl2 — local QA Home server, `agent-qa-l12-b`

Source/package root: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native`.

Materialized artifact: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`; SHA-256 **`da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`**.

Observed before delivery: the artifact did not exist; server PID **1459554** had no Iroh addon mapping. Its loaded source identity is **095f08ad9a3edf98**. The actual emitted loader in `/home/leeroy.guest/.happier/stacks/source-bundles/runtime-44872334a429691b89aa081002ef87214f245bd927c61e553ea715ef6e87366c-SSVVeV/apps/server/src/chunks/chunk-ZRCY6KVJ.js` contains `moduleUrl="file:///home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/src/nodeNative.ts"`, proving this exact physical package root rather than an inferred bundle-relative copy. The physical host is Linux x64, glibc 2.39, Node executable `/usr/bin/node`.

Delivery used `/tmp/happier-ops2-materialize.mjs`: canonical `hstack-exec --target=nl3 -- node ...` reads only the ordinary built binary, transfers it in captured base64 stdout, verifies the expected SHA-256 before installation, then writes and renames an ignored temporary artifact into the deterministic local path. It refused an unexpected existing destination, checked the installed bytes again, and printed only path/size/hash. Handle **85643**, exit **0**. The script retained no binary content in chat. No local Rust/compiler/test process was used.

Derived pickup: the existing loader and future source preparation resolve the now-present ordinary artifact at that same root. The orchestrator must restart the Home server through its existing lifecycle owner so any prior native-unavailable state is recreated. **No additional native flag, package-root override, environment change, or copied bundle sidecar is required.** Local native load/endpoint smoke remains unrun under this brief's remote-validation restriction; delivery proof is exact identity with the symbol-verified, real-loader-tested Linux artifact on nl1/nl3.

### nl1 — SOURCE daemon, Machine `d06f323d-88fa-4491-bc40-aebac4734bd6`

Source/package root: `/home/happier/happier-dev/packages/iroh-native`.

Built Cargo output: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.

Installed ordinary artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`; SHA-256 **`da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`**. Before rebuilding, its disk hash was `09b1c84bf388bda008cea69519419f9333d4a48aaf6b3b48fc7eb2ba82f8f308`.

Canonical state: `/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/stack.runtime.json`. Final readback preserves owner **3610940**, daemon **3611974**, start **2026-10-18T05:32:39.547Z**, selected/loaded source identity **9ca2d4f0821978a3**. Actual entry is the `runtime-64cfb47ea7e4858ba686b562ff55fb8ce0c8ea0c60566e64730e2a498bdfe0de-n9msNw` bundle beneath that target's `stack-state/source-bundles`, running `apps/cli/package-dist/index.mjs`.

Observed `/proc/3611974/maps` initially names the physical source artifact; after the canonical builder replaced its inode it names the same path with **`(deleted)`**. Thus the preserved wedged daemon continues mapping its old bytes; a successful disk rebuild is not a loaded-runtime correction. The builder removes the old file before copying, so it did not overwrite mapped bytes in place.

Derived pickup: the next daemon process loads the corrected ordinary artifact from the same host source root. The orchestrator owns SOURCE reload and subsequent managed-Service Stop/stability replay. **No native-specific flag or source-selection mutation is needed.**

### nl3 — worker namespace `l12b-nl3-worker`, Machine `444aa1ca-1a63-4dd6-93e4-9b34bb8c72d8`

Source/package root: `/home/happier/happier-dev/packages/iroh-native`.

Built Cargo output: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.

Installed ordinary artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`; SHA-256 **`da6226e198171937e8183fe622a47c459127462f5b8c8cbd854ae68e1385365c`**. This already matched FX122's corrected disk binary; the canonical rebuild confirmed it in 0.22 seconds.

Canonical state: `/home/happier/.happier/stacks/l12b-nl3-worker/stack.runtime.json`. Current readback supersedes the older FIXT4 PIDs: owner **895111**, daemon **896167**, start **2026-10-18T05:46:28.634Z**, selected/loaded source identity **d5e1454fd4677637**, actual `apps/cli/package-dist/index.mjs` under `/home/happier/.happier/stacks/source-bundles/runtime-c47b64608bbf2f02277a74101e55cd95322cc865faa87dcbc228895308c9cbb6-geO5GO`.

Observed daemon maps name the ordinary physical source artifact with **`(deleted)`**, both before and after OPS2's rebuild. Its mapped inode is not the corrected disk file. Derived pickup: recreate the worker process through its existing namespace lifecycle owner; its existing `--runtime=source --reuse-source-runtime` launch resolves this physical addon without a new native flag. OPS2 did not prepare/select another bundle or invoke the start/stop helpers. Any identity-guarded teardown helper must be reconciled by the orchestrator with these current PIDs/start time; the historical FIXT4 expectations **1868903/1869319** are stale and must not be used to identify this runtime.

## Executed checks and command evidence

All native builds and executed native validation used synchronized `./apps/stack/bin/hstack-exec` on the exact consumer hosts. The brief explicitly authorizes remote computation/workspace transfer under the standing **2026-10-10 authorization**. Commands ran against continuously moving mirrors at `/home/happier/happier-dev`, with the canonical prelaunch Mutagen flush. No `--local`, direct `*:local`, whole-package local TypeScript compilation, release packaging, or QA lifecycle command was used.

Build command on each host, with that host user's existing Cargo bin prepended to PATH:

```sh
node packages/iroh-native/scripts/ensure-rust-toolchain.mjs --platform host
node packages/iroh-native/scripts/build-node-addon.mjs
sha256sum packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node
nm -C packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node | rg -m 3 run_lifecycle_operation
```

| Check | nl1 | nl3 |
| --- | --- | --- |
| Pinned Rust preparation | 1.94.1 already ready | 1.94.1 already ready |
| Canonical ordinary release build + hash + dispatch symbols | handle **22330**, exit **0**, Rust compile **10.15 s** | handle **55945**, exit **0**, build **0.22 s** |
| FX122 retired-peer regression through real typed loader → NAPI → native lifecycle | handle **32270**, exit **0**, **1 passed / 8 filtered**, test **3020 ms** | handle **63169**, exit **0**, **1 passed / 8 filtered**, test **3019 ms** |
| Canonical `verify-node-addon-load.mjs` | handle **53651**, exit **0**, Node **24.21.0**, load **2.135 ms**, endpoint **14.484 ms** | handle **63442**, exit **0**, Node **24.21.0**, load **1.696 ms**, endpoint **14.548 ms** |

Regression command on each host:

```sh
env UV_THREADPOOL_SIZE=4 HAPPIER_IROH_REQUIRE_NODE_ADDON=1 \
  node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  packages/iroh-native/src/nodeNativeLifecycle.test.ts \
  -t 'retired-peer dials' --maxWorkers=1 --reporter=verbose
node packages/iroh-native/scripts/verify-node-addon-load.mjs
```

The regression preserves the real producer/consumer path and uses no mocks. Its eight nonmatching neighbors are filtered, not claimed as run. This lane changes no production behavior/source or tests, so it does not manufacture another RED; the correction's original RED belongs to FX122. No new package typecheck/build gate is applicable beyond the actual native builds/materialization performed here.

## Limits, setbacks, and final self-check

Initial retrieval guessed `TRACKING.md` one directory too high and guessed nonexistent Stack utility directories. Those searches exited nonzero; the canonical tracking file was read at `impl-B/TRACKING.md`, and the actual build/preparation owners were inspected. An early remote search could not see ignored `.project` reports; they were read locally. `repo_local.mjs dev-targets status` returned exit 0 without output, so it supplied no readiness evidence; subsequent canonical exact-target `hstack-exec` commands established successful synchronized execution. No product/test failure or unattributed runtime failure was observed in OPS2; SOURCE's existing wedge remains the known FX122 condition.

The in-place adversarial check tested the misleading alternatives “correct disk binary means loaded correction” and “server bundle owns a copied addon.” Actual process mappings falsify the first, and the emitted server loader plus build owner falsify the second. Final readbacks independently confirm all three disk hashes and unchanged process/start/source identities. Neither old source identity nor a fresh JavaScript preparation is native activation evidence.

No credential reader, forbidden key file, retained database, Git index/branch, unrelated source hunk, Windows-worker namespace, QA forward, or foreign process was changed. Existing FX122 source/test/README edits remain intact. OPS2 authored only this requested report and the temporary binary-materialization helper; the native output is ignored build output.

Residual risk / next owner: all three runtime processes still require the orchestrator's authorized reload. The composed Home/SOURCE/worker journey, preserved SOURCE managed-Service cleanup, and restart stability remain unrun by design. nl2 delivery has hash/symbol provenance rather than a local executed native smoke; confirm its real Home native initialization after reload. Do not describe the runtime correction as loaded until those process observations succeed.
STATUS: DONE
