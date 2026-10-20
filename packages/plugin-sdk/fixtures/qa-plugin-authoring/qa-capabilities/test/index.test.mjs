import assert from 'node:assert/strict';
import test from 'node:test';

import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

test('public activation and the runner leaf share the exact factory; MCP tools execute', async () => {
  const module = await import('../dist/index.js');
  assert.deepEqual(module.manifest.contributes.skills, [
    { id: 'check-capabilities', directory: './resources/skills/check-capabilities' },
  ]);
  const plugin = await createPluginTestkit({ manifest: module.manifest, module });
  try {
    const registration = plugin.registration('agents', "session-agent");
    const leaf = await import(`../dist/${registration.sessionRunnerFactory.module}`);
    assert.equal(leaf[registration.sessionRunnerFactory.export], registration.factory);
    const server = plugin.registration('mcp.servers', 'fixture-tools');
    const tools = await server.listTools({});
    assert.equal(tools.items[0].name, 'status');
    assert.deepEqual(await server.callTool({ name: tools.items[0].name, input: {} }), {
      content: [{ kind: 'json', value: { status: 'ready' } }],
    });
  } finally {
    await plugin.dispose();
  }
});
