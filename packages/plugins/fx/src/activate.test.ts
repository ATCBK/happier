import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

describe('activate', () => {
  it('reexports the activation compiled by its canonical public plugin definition', async () => {
    expect(Object.keys(PLUGIN_MANIFEST.contributes).sort()).toEqual([
      'agents',
      'systemTools',
      'ui',
    ]);
    expect(await import('./manifest.js')).toEqual(expect.objectContaining({
      FX_PLUGIN: expect.objectContaining({ manifest: PLUGIN_MANIFEST, activate }),
    }));
  });

  it('binds the declarative FX ACP agent and its interactive terminal without a custom factory', async () => {
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const registration = activation.registration('agents', 'fx');
      expect(registration?.externalSessions).toBeDefined();
      expect(registration).not.toHaveProperty('factory');
      expect(registration).not.toHaveProperty('sessionRunnerFactory');
      expect(registration).not.toHaveProperty('cliSessionCommand');
      // The host appends `argv` after the Agent CLI executable it resolved, so
      // the leaf contributes arguments only.
      await expect(registration?.terminal?.resolveLaunch({
        sessionId: 'session', cwd: '/workspace', metadata: {}, modelSelection: null,
      })).resolves.toMatchObject({ argv: [] });
    } finally {
      await activation.dispose();
    }
  });
});
