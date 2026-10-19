import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Observe the real module system in a fresh process; do not replace any host
// catalog, runtime, or renderer implementation.
const loaded = new Set();
registerHooks({
  load(url, context, nextLoad) {
    const family = /\/node_modules\/(ink|react|react-reconciler|yoga-layout)\//u.exec(url)?.[1];
    if (family) loaded.add(family);
    return nextLoad(url, context);
  },
});

const { createNativeAgentHostSessionRuntimePlan } = await import('../../../../../plugins/runtime/runtimeCore/plugin/session.ts');
const plan = await createNativeAgentHostSessionRuntimePlan({
  backend: {
    id: 'headless-fixture', agentId: 'headless-fixture', provenance: 'external',
    source: { kind: 'path' }, pluginId: 'fixture.agent',
    definition: { kindVersion: 1, id: 'headless-fixture', agentId: 'headless-fixture' },
  },
  agent: {
    id: 'headless-fixture', provenance: 'external', source: { kind: 'path' }, pluginId: 'fixture.agent',
    definition: { kindVersion: 1, id: 'headless-fixture', ownedBackendIds: ['headless-fixture'] },
  },
  policyAgentId: 'custom-acp',
  sessionInput: {
    credentials: { token: 'fixture-not-a-credential', encryption: null },
    bootstrap: { source: 'daemon' }, resume: {}, runtimePreferences: {},
  },
  createSessionRuntime: async () => { throw new Error('Plan construction must not start an Agent'); },
});
assert.equal(plan.kind, 'hostSessionRuntimePlan');
const headlessLoaded = [...loaded].sort();

// Positive control through the actual plan producer, not an unrelated import.
await plan.config.loadTerminalDisplay();
assert(loaded.has('ink'), 'Module-load observer did not see Ink');
assert(loaded.has('yoga-layout'), 'Module-load observer did not see Yoga');
process.stdout.write(`${JSON.stringify({ headlessLoaded, renderedLoaded: [...loaded].sort() })}\n`);
