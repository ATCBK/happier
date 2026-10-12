import { describe, expect, it } from 'vitest';

import { ANTIGRAVITY_UI_DESCRIPTOR } from './descriptor.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

describe('Antigravity UI descriptor', () => {
  it('keeps Antigravity UI projection as no-execute descriptor data', () => {
    expect(JSON.parse(JSON.stringify(ANTIGRAVITY_UI_DESCRIPTOR))).toEqual(ANTIGRAVITY_UI_DESCRIPTOR);
    expect(ANTIGRAVITY_UI_DESCRIPTOR).toMatchObject({
      kind: 'plugin.ui.v1',
      pluginId: 'antigravity',
      agentId: 'antigravity',
      display: {
        nameKey: 'agentInput.agent.antigravity',
        connectedService: { serviceId: 'happier.agent.antigravity/antigravity-account' },
        localControl: true,
      },
    });
    expect(ANTIGRAVITY_UI_DESCRIPTOR).not.toHaveProperty('settings');
  });

  it('declares the managed ACP server as the only New Session installable dependency', () => {
    // Happier ACP sessions run the managed `agy_acp_server`, so New Session
    // availability must auto-install that dependency instead of requiring the
    // optional interactive `agy` CLI. The key is the managed dependency's own
    // install id, which is what the host projects as the installable key.
    const installId = PLUGIN_MANIFEST.contributes.managedDependencies[0]?.sources[0]?.installId;
    expect(installId).toBe('dep.antigravity.agy-acp-server');
    expect(ANTIGRAVITY_UI_DESCRIPTOR.behavior.newSession.relevantInstallableDepKeys).toEqual([installId]);
  });
});
