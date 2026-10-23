# @happier-dev/iroh-native

Optional native lifecycle substrate for the Iroh Home carrier. JavaScript,
Swift, and Kotlin expose lifecycle/status only; all stream bytes stay in Rust.
When unavailable, callers retain the existing HTTPS carrier.

The Rust core owns one shared process endpoint per endpoint identity (persistent
key path), explicit relay ownership (`automatic` with explicit descriptor relay
URLs → custom relay map; `disabled` → `RelayMode::Disabled`; never ambient n0
infrastructure), and the frozen cap profiles enforced at the QUIC transport
boundary. One handle-based JSON lifecycle exists on the native owner:
`createEndpoint`, `startHomeAcceptor`,
`ensureHomeTunnel`, `releaseHomeTunnel`, `stopHomeAcceptor`, `shutdownEndpoint`,
`getEndpointStatus`, and `getTunnelStatus`. Releasing one lease never shuts the
shared endpoint or sibling leases down; the application endpoint remains alive
until process/native lifecycle shutdown.

The Expo module links the shared `rust/happier-iroh-native` crate. Android builds
produce `arm64-v8a` and `x86_64` JNI libraries through `scripts/build-rust-android.sh`;
iOS CocoaPods builds produce a static `HappierIrohNativeRust.xcframework` through
`scripts/build-rust-ios.sh`. The scripts require the matching Rust targets and
Android NDK/Xcode toolchains on the build host.

## Node/Bun lifecycle addon (server/desktop)

`@happier-dev/iroh-native/node` exposes the same JSON C ABI lifecycle owner to
Node and Bun. The thin NAPI crate `rust/happier-iroh-node` links the
`happier-iroh-native` rlib, so the exported `happier_iroh_native_*_json`
operations and `happier_iroh_native_free_string` run against the one
process-wide `OnceLock` runtime, `NativeRuntime`, `EndpointManager`, acceptor
set, and tunnel-lease map. The binding adds no runtime, no lifecycle logic,
and no payload APIs: requests and responses are validated JSON envelopes, and
tunnel bytes never cross.

In 0.3 development source, the binding dispatches synchronous lifecycle calls
to that native runtime's blocking pool and settles JavaScript promises through
NAPI deferreds. Pending peer dials therefore leave Node's shared filesystem/DNS
workers available for daemon logging, heartbeat persistence and request admission.
The runtime starts on the first native lifecycle operation, not addon load or
allocator maintenance. One background worker drives the asynchronous endpoint,
relay and tunnel I/O, including between lifecycle calls; blocking lifecycle waits
use the separate on-demand blocking pool. Standard-only daemon startup skips the
endpoint; Iroh-eligible Machines keep it listening for incoming carrier work.
Existing processes need the rebuilt addon and a runtime restart to consume this
correction; changing TypeScript source alone does not replace a loaded addon.

The development transport also retains Iroh's default keepalives and dead-peer
idle timeout, so an abruptly retired peer cannot leave native streams waiting
forever. Healthy application-idle connections remain usable. See the
[carrier lifetime contract](../../docs/peer-mediation.md) for the distinction
between transport liveness and application deadlines.

```ts
import { loadIrohNodeNative } from '@happier-dev/iroh-native/node';

const loaded = loadIrohNodeNative(); // or loadIrohNodeNative(packageRoot) in packaged hosts
if (!loaded.available) {
  // typed { reason: 'native_unavailable', message } — never a guessed binary
} else {
  const endpoint = await loaded.native.createEndpoint({ keyPath, relayPolicy: 'automatic' });
  const acceptor = await loaded.native.startHomeAcceptor({ endpointHandle: endpoint.endpointHandle, targetPort });
  const lease = await loaded.native.ensureHomeTunnel({
    endpointHandle: endpoint.endpointHandle,
    homeServerIdentityId,
    endpointId: endpoint.endpointId,
    directAddresses,
  });
  await loaded.native.releaseHomeTunnel(lease.tunnelId);
  await loaded.native.shutdownEndpoint({ endpointHandle: endpoint.endpointHandle });
}
```

Artifact layout and resolution:

- one deterministic name per platform/arch:
  `native/happier-iroh-native-lifecycle.<platform>-<arch>.node`;
- supported targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
  `win32-x64`; the build script targets the current host (Linux defaults to
  the gnu targets, pass `--musl` on musl hosts — one host has one libc);
- missing artifact, unsupported pair, or wrong surface ⇒ typed
  `native_unavailable` result; the loader never silently selects an
  unrelated binary;
- packaged hosts (Bun single-file server) pass the explicit `packageRoot`, or
  load one artifact directly with `loadIrohNodeNativeAddon(addonPath)`.

Build and verify on a host with a Rust toolchain:

```sh
node packages/iroh-native/scripts/build-node-addon.mjs        # cargo build + copy into native/
node packages/iroh-native/scripts/verify-node-addon-load.mjs  # Node load + lifecycle smoke
bun  packages/iroh-native/scripts/verify-node-addon-load.mjs  # same smoke under Bun
```

The addon exposes exactly the lifecycle operations listed in
`IROH_NODE_NATIVE_EXPORTS`;
`src/nodeNoPayloadCrossing.test.ts` enforces that surface against
typed-array/byte/payload/generic-dispatch APIs, and
`src/nodeNativeLifecycle.test.ts` proves shared-endpoint behavior through the
real binding when the artifact is built (skipped otherwise).

The forced-relay test fixture uses the pinned iroh local relay test facility and
is compiled only under the test-only `test-relay-fixture` cargo feature; it is
never a release behavior dependency. Build that separate host-only fixture with
`node packages/iroh-native/scripts/build-node-addon.mjs --test-relay-fixture`;
it writes a `native-test/happier-iroh-native-lifecycle-test.<platform>-<arch>.node` artifact
whose force/restore/observed-path operations are absent from the ordinary addon.
The fixture refuses topology changes while endpoints are active and drops its
local relay when `restoreAutomatic` succeeds.

## Real transport checks

Run the source-level native and browser journeys through their existing owners:

```sh
pnpm --dir packages/iroh-native run test:home-iroh:real
pnpm --dir apps/ui run proof:browser-iroh-real-verticals
```

The Docker relay journey uses the pinned stock relay image in
`deploy/iroh-relay/Dockerfile` and requires a running Docker engine:

```sh
pnpm --dir packages/iroh-native run test:home-iroh:docker
```

It verifies relayed file and attachment bytes against the stock containerized
relay, then exercises a fresh production Home and daemon as host test processes.
The same-host Home connection may take the direct path; its configuration alone
is not evidence of relay carriage. This does not simulate mobile network
transitions or arbitrary Internet NATs.
