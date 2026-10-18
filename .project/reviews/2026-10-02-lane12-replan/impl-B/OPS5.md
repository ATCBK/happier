# OPS5 — current ordinary addon verified and aligned on all three QA consumers

Completed artifact preparation: **nl2, nl1 and nl3 now have the ordinary Linux x64 addon SHA-256 `9292b776af4475aff459883127def7eda2533cd551ca9f112703b94cb2c7648f`, 17,544,600 bytes.** nl3's newly observed binary matches a current canonical release build and was retained without replacing its installed inode. nl1 was rebuilt and atomically installed; nl2 received the identical verified bytes by atomic rename. **RELOAD NEEDED — orchestrator only: QA Home server `agent-qa-l12-b` on nl2, SOURCE daemon on nl1, and worker namespace `l12b-nl3-worker` on nl3.** No runtime was restarted, reloaded, signaled or killed. Native builds and selected regressions passed; loaded QA activation and post-reload journeys remain unrun by design. nl2 native smoke was not executed locally. One initial remote lookup could not access ignored `.project` reports; the required tracking evidence was subsequently read locally. No build/test failure or new unattributed live failure was observed.

## Observed canonical owner and pickup contract

- `packages/iroh-native/scripts/build-node-addon.mjs` builds the ordinary `happier-iroh-node` crate with pinned Cargo, `--locked`, release, target `x86_64-unknown-linux-gnu`. The Cargo output is `packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`. The ordinary destination is `packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`; the test-relay addon is separate and was not installed or built here.
- `apps/stack/scripts/runtime/launch/prepareSourceRuntimeReload.mjs:21` invokes the source-runtime builder. `apps/stack/scripts/build/build_source_runtime.mjs:789` retains the execution host's physical `packages/iroh-native/src/nodeNative.ts` URL in the bundled loader. `packages/iroh-native/src/nodeNative.ts:108` resolves that package root and `:144` selects its deterministic ordinary artifact. Inspection of these owners found no Iroh addon rebuild or bundle-sidecar copy. Source preparation **reuses the host's prebuilt ordinary binary**.
- Actual loaded chunks independently confirm those locators on every named consumer, listed below. Derived pickup: the next process using either retained or freshly prepared source bundles resolves the ordinary addon at that same physical host package root. **No new native flag, package-root override, source-selection mutation or sidecar copy is needed.** An already loaded native addon requires process recreation through the existing lifecycle owner.
- Current `happier-iroh-core/src/limits.rs` retains the default transport liveness policy and contains no `max_idle_timeout(None)` override. Current `happier-iroh-node/src/lib.rs` retains `run_lifecycle_operation`. Both host binaries expose symbols combining that dispatch with Tokio `BlockingTask`, and both hosts passed the applied transport-configuration regression.

No production source, test, loader, lifecycle owner, runtime registry or compatibility path was changed. This lane materializes existing source corrections, so it introduces no new behavior requiring another RED. FX122/FX129 own their original RED evidence; their reports are not substituted for the fresh checks below. No UI renders or styles changed. The historical windows1-linux build recipe in `impl-B/TRACKING.md:403–405` was read: package-owned pinned Rust preparation, canonical addon build, then verify; that separate worker is outside this assignment and was untouched.

## Safety and exact preparation recipe

The builder removes/copies its selected output and offers no output-directory flag. `/tmp/happier-ops5-host.mjs` therefore repeated OPS3's safe recipe: copy the **unchanged canonical builder** into a fresh ignored staging package root beneath `packages/iroh-native/native/.ops5-staging-*`, symlink its `rust` directory to the real Rust workspace, and set `CARGO_TARGET_DIR` to the real cached `packages/iroh-native/rust/target`. The canonical builder only writes its staging addon. Compare that result with the ordinary destination; if different, confirm the destination and runtime snapshots have not changed, then install with same-filesystem `renameSync`. No mapped `.node` file was truncated or overwritten in place.

Both hosts reported pinned Rust **1.94.1 already ready** via `ensure-rust-toolchain.mjs --platform host`; no toolchain installation was needed. Staging roots: nl1 `native/.ops5-staging-Z4AFyv`, nl3 `native/.ops5-staging-XOwiU8`. On nl3, Cargo finished in **0.24 s** and its library, staged addon and existing ordinary addon all hashed to `9292b776…`; installation was deliberately skipped. This proves equivalence to the current build, not who historically produced LV33's binary. nl1's canonical build finished in **1.23 s** and produced the same hash.

nl2 repeated OPS2/OPS3's synchronized binary transport. `/tmp/happier-ops5-materialize.mjs` captured only the ordinary nl3 artifact through `hstack-exec --target=nl3 -- node ...` as base64, kept the binary contents out of chat, verified the expected SHA-256, required the previously inspected destination hash/inode and runtime identities to remain unchanged, wrote an exclusive temporary sibling, and renamed it onto the ordinary destination. Installed bytes, new inode and preserved process snapshots were checked again. No local Rust/compiler/native-smoke process ran.

## Per-host artifacts and preserved runtime evidence

### nl2 — QA Home server `agent-qa-l12-b`

- Source/package root: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native`.
- Installed artifact: `/home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`.
- Final SHA-256: **`9292b776af4475aff459883127def7eda2533cd551ca9f112703b94cb2c7648f`**, **17,544,600 bytes**, inode **91558760**. Previous hash `643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`, inode **91572361**. No local Cargo artifact was produced; the installed bytes are identical to both independently verified remote builds.
- State: `/home/leeroy.guest/.happier/stacks/agent-qa-l12-b/stack.runtime.json`. Owner **2620894**, server **2626751**, start **2026-10-18T19:48:26.180Z**; server selected=loaded **cbc129bda38bd6ae**. Owner/server start ticks **78042583 / 78043371** remained unchanged.
- Loaded entry: `/home/leeroy.guest/.happier/stacks/source-bundles/runtime-1606705715cdad8fa7904f2a4aac8bf02c7ece493080b6e73c3dddb3bbc4c2d3-9P5jQj/apps/server/sources/main.mjs`. Its `apps/server/src/chunks/chunk-5GO7WVSD.js` contains `file:///home/leeroy.guest/.happier-stack/workspace/0.3/packages/iroh-native/src/nodeNative.ts`.
- There was **no Iroh addon mapping** before delivery, after delivery or at final readback. No mapped local inode needed replacement. Final readback **20:18:15.836Z**, evidence `/tmp/happier-ops5-final-nl2.json`.
- Derived next pickup: recreate Home through its existing owner; its physical package now supplies the verified ordinary addon. No native-specific flag is required.

### nl1 — SOURCE Machine `d06f323d-88fa-4491-bc40-aebac4734bd6`

- Source/package root: `/home/happier/happier-dev/packages/iroh-native`.
- Cargo artifact: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.
- Installed artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`.
- Final SHA-256: **`9292b776af4475aff459883127def7eda2533cd551ca9f112703b94cb2c7648f`**, **17,544,600 bytes**, inode **20590570**. Previous hash `643bfa2f23d09130375b62230c209cbd058fd6e88098ff47a31b3938c5281edb`, inode **20590573**.
- State: `/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/stack.runtime.json`. Owner **3576087**, daemon **3576763**, start **2026-10-18T19:52:09.695Z**; selected=loaded **16bac72645ede764**. Owner/daemon start ticks **78869840 / 78871255** remained unchanged.
- Loaded entry: `/home/happier/.happier/dev-targets/nl1/stack-state/source-bundles/runtime-2d6e23494fc0138ae1e0cac669f34878d13bc5a3a0c9d827293d2e196310ff46-6THtz9/apps/cli/package-dist/index.mjs`. Its `apps/cli/src/chunks/chunk-6SE34SC3.js` contains `file:///home/happier/happier-dev/packages/iroh-native/src/nodeNative.ts`.
- All four `/proc/3576763/maps` addon ranges retained the same permissions, offsets and old inode **20590573**; after atomic installation the path is **`(deleted)`**. The daemon never mapped the new disk inode. Final readback **20:18:16.224Z**, evidence `/tmp/happier-ops5-final-nl1.json`.
- Derived next pickup: recreate SOURCE through the established dev-target stack lifecycle owner; no native-specific flag or source-selection change is required.

### nl3 — worker namespace `l12b-nl3-worker`, Machine `444aa1ca-1a63-4dd6-93e4-9b34bb8c72d8`

- Source/package root: `/home/happier/happier-dev/packages/iroh-native`.
- Cargo artifact: `/home/happier/happier-dev/packages/iroh-native/rust/target/x86_64-unknown-linux-gnu/release/libhappier_iroh_node.so`.
- Accepted ordinary artifact: `/home/happier/happier-dev/packages/iroh-native/native/happier-iroh-native-lifecycle.linux-x64.node`.
- Final SHA-256: **`9292b776af4475aff459883127def7eda2533cd551ca9f112703b94cb2c7648f`**, **17,544,600 bytes**, inode **20063048**, unchanged throughout OPS5. The current canonical staged build reproduces these exact bytes, so LV33's newly observed binary is acceptable and was not replaced.
- State: `/home/happier/.happier/stacks/l12b-nl3-worker/stack.runtime.json`. Owner **1017529**, daemon **1019565**, start **2026-10-18T17:31:26.457Z**; selected=loaded **4d285afa80196e8a**. Owner/daemon start ticks **53592660 / 53593526** remained unchanged.
- Loaded entry: `/home/happier/.happier/stacks/source-bundles/runtime-12cd7852389fb524fd18e696994441c8e584f3ec897257302959b38afb69a9b9-WwUXYM/apps/cli/package-dist/index.mjs`. Its `apps/cli/src/chunks/chunk-PETREP4B.js` contains `file:///home/happier/happier-dev/packages/iroh-native/src/nodeNative.ts`.
- The worker retains four mappings of older inode **20090336**, already **`(deleted)`** before OPS5. Ranges, permissions and offsets remained unchanged; it does not map current disk inode **20063048**. Final readback **20:18:21.132Z**, evidence `/tmp/happier-ops5-final-nl3.json`.
- Derived next pickup: the existing namespace launch, including its established `--runtime=source --reuse-source-runtime` recipe, resolves the accepted ordinary binary. No new native flag is required. Preserve namespace custody and forward **41631**; historical teardown PIDs from OPS2/OPS3/FIXT4 are stale.

## Fresh executed validation

All builds and executed product validation ran through synchronized `./apps/stack/bin/hstack-exec` on the exact nl1/nl3 hosts, against the continuously moving `/home/happier/happier-dev` mirrors. The brief authorizes remote computation/workspace transfer under the standing **2026-10-10 authorization**. Canonical target status checks reported ready and launches used their normal synchronization barrier. No `--local`, direct `*:local`, local whole-package compilation, release packaging or Stack lifecycle operation ran.

| Check | nl1 | nl3 |
| --- | --- | --- |
| Pinned Rust preparation; staged canonical ordinary release build; conditional atomic install; symbol verification | Handle **48515**, exit **0**; installed new inode | Handle **59829**, exit **0**; existing inode retained |
| Applied FX129 transport-config regression | **1 passed / 80 filtered**, same handle | **1 passed / 80 filtered**, same handle |
| Canonical `verify-node-addon-load.mjs` | Node **24.21.0**, load **1.818 ms**, endpoint **11.506 ms**, exit **0** | Node **24.21.0**, load **2.010 ms**, endpoint **11.194 ms**, exit **0** |
| FX122 real loader → ordinary NAPI → native lifecycle responsiveness | **1 passed / 8 filtered**, **3022 ms**, exit **0** | **1 passed / 8 filtered**, **3021 ms**, exit **0** |
| Final artifact, source locator and unchanged-process readback | Handle **60832**, exit **0** | Handle **39951**, exit **0** |

Raw combined build/test output: `/tmp/happier-ops5-nl1.log`, `/tmp/happier-ops5-nl3.log`. Helper: `/tmp/happier-ops5-host.mjs`. nl2 atomic transfer: helper `/tmp/happier-ops5-materialize.mjs`, handle **69870**, exit **0**, **20:17:51.848Z**. Exact final snapshots are the three `/tmp/happier-ops5-final-<host>.json` files above.

The helper invokes the following existing checks with the host user's Cargo bin on PATH, after staging the unchanged canonical builder:

```sh
node packages/iroh-native/scripts/ensure-rust-toolchain.mjs --platform host
cargo test --locked --manifest-path packages/iroh-native/rust/Cargo.toml \
  -p happier-iroh-core profiles_bound_only_real_per_connection_resources
node packages/iroh-native/scripts/verify-node-addon-load.mjs
env UV_THREADPOOL_SIZE=4 HAPPIER_IROH_REQUIRE_NODE_ADDON=1 \
  node node_modules/vitest/vitest.mjs run --config vitest.config.ts \
  packages/iroh-native/src/nodeNativeLifecycle.test.ts \
  -t 'retired-peer dials' --maxWorkers=1 --reporter=verbose
```

The selected real-binding regression uses the installed ordinary addon and real internal wiring; no mocks were added. Nonmatching tests were filtered, not executed. The FX129 abrupt-process-restart integration and 35-second healthy-idle neighbor were not rerun here; applied-config regression plus current-build equivalence establish the requested correction basis. No TypeScript/source change was made, so no additional package typecheck was run and prior foreign UI diagnostics are not cleared by this report.

## Reload handoff, self-check and residual risk

**RELOAD NEEDED:** after the active live lane releases the runtimes, the orchestrator must recreate the nl2 QA Home server, nl1 SOURCE daemon and nl3 namespace worker through their existing owners. Then verify new-process addon mappings and execute FX129's post-worker-restart composed Script/Move/Stop journey: keep SOURCE up; retire/recreate the owned worker; replay fresh UI-approved qaW `ok`/`fail` and SOURCE→nl3→SOURCE Service Move→normal Stop; join settled flushes with native exits **0/17**, fresh bytes, final placement and native absence. No native-specific flag is needed. OPS5 did not invoke preparation, source selection or that live recipe.

The in-place adversarial check challenged stale reports with current loaded-chunk locators and process mappings, challenged LV33's unknown build provenance with exact current canonical-build equivalence, and challenged symbol-only confidence with the actual transport-config owner test and real-binding responsiveness test. Correct disk bytes do not establish loaded activation: both preserved daemons still map older unlinked inodes. Unchanged process identities/mappings establish preservation across this work, not authenticated health or acceptance of LV30/LV33.

Only the requested report, temporary helpers/evidence and ignored native build outputs were authored. Existing dirty Rust/verification-script work was preserved. No credential reader, forbidden access/recovery key, retained database, Git branch/index, unrelated source hunk, Windows worker, QA forward or foreign process was changed. No additional loader or competing dispatch/liveness owner was introduced; the canonical build and physical-package loader remain authoritative.

Residual risk: the next orchestrator-owned reload and composed loaded-runtime replay remain pending by explicit task boundary. nl2 has exact binary provenance rather than an executed local native smoke; verify its native initialization after reload. Native Windows/macOS, mobile, browser WASM, packaging and release validation were not run or certified. The source mirror remains moving; later external rebuilds can change disk bytes after these timestamped readbacks.
STATUS: DONE
