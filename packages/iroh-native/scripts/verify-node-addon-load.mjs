#!/usr/bin/env node
// Typed lifecycle smoke for source and packaged hosts. The same script runs in
// Node, Bun, and a Bun-compiled executable; --package-root points Node/Bun at
// an extracted release payload while a compiled smoke beside node_modules
// exercises the loader's production default discovery.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { loadIrohNodeNative, loadIrohNodeNativeAddon } from "../dist/nodeNative.js";

const packageRootFlag = process.argv.indexOf("--package-root");
const packageRoot = packageRootFlag >= 0
  ? String(process.argv[packageRootFlag + 1] ?? "").trim()
  : undefined;
if (packageRootFlag >= 0 && !packageRoot) {
  throw new Error("--package-root requires a value");
}
const addonLoadStartedAt = performance.now();
const loaded = loadIrohNodeNative(packageRoot);
const addonLoadMilliseconds = performance.now() - addonLoadStartedAt;
if (!loaded.available) {
  throw new Error(loaded.message);
}
const native = loaded.native;
const addon = loadIrohNodeNativeAddon(loaded.addonPath);
assert.equal(typeof addon.trimProcessAllocator, "function");
// Allocator maintenance also serves standard-only daemons, which must not
// start Iroh's CPU-sized worker pool merely to release unused memory.
const tokioWorkers = () => process.platform === "linux"
  ? readdirSync('/proc/self/task').filter(id => {
    try { return readFileSync(`/proc/self/task/${id}/comm`, 'utf8').trim().startsWith('tokio'); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }).length : 0;
const workersBeforeTrim = tokioWorkers();
const trim = addon.trimProcessAllocator();
assert.equal(typeof trim.then, "function");
const released = await trim;
assert.equal(typeof released, "boolean");
if (process.platform !== "linux") assert.equal(released, false);
assert.equal(tokioWorkers(), workersBeforeTrim, "allocator maintenance started the Iroh runtime");

// Real loopback endpoint lifecycle (relay disabled: no external traffic).
const endpointStartupStartedAt = performance.now();
const created = await native.createEndpoint({ relayPolicy: "disabled" });
const endpointStartupMilliseconds = performance.now() - endpointStartupStartedAt;
const status = await native.getEndpointStatus(created.endpointHandle);
if (!status?.endpointId || !Array.isArray(status.directAddresses)) {
  throw new Error(`endpoint status missing identity/addresses: ${JSON.stringify(status)}`);
}
await native.shutdownEndpoint({ endpointHandle: created.endpointHandle });
const afterShutdown = await native.getEndpointStatus(created.endpointHandle);
if (afterShutdown !== null) throw new Error("endpoint remained active after shutdown");

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`;
process.stdout.write(
  `loaded ${loaded.addonPath} in ${runtime} (endpoint ${status.endpointId})\n${JSON.stringify({
    addonBytes: statSync(loaded.addonPath).size,
    addonLoadMilliseconds: Number(addonLoadMilliseconds.toFixed(3)),
    endpointStartupMilliseconds: Number(endpointStartupMilliseconds.toFixed(3)),
  })}\n`,
);
