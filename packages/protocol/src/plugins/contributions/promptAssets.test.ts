import { describe, expect, it } from 'vitest';

import { derivePluginDaemonContributionRegistrationRights } from './catalog.js';
import { PluginContributesV2Schema } from './v2.js';

describe('plugin prompt asset contributions', () => {
  it('parses digest-resource prompt assets targeted to an Agent', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [
        {
          id: 'security-review',
          kind: 'systemPrompt',
          resource: 'security-review-prompt',
          target: { kind: 'agent', agent: 'deepsec' },
          priority: 20,
        },
      ],
    });

    expect(parsed.promptAssets).toEqual([
      {
        id: 'security-review',
        kind: 'systemPrompt',
        resource: 'security-review-prompt',
        target: { kind: 'agent', agent: 'deepsec' },
        priority: 20,
      },
    ]);
  });

  it('rejects provider-targeted prompt assets', () => {
    expect(() =>
      PluginContributesV2Schema.parse({
        promptAssets: [
          {
            id: 'security-review',
            kind: 'systemPrompt',
            resource: 'security-review-prompt',
            target: { kind: 'provider', provider: 'deepsec' },
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects the retired external adapter declaration', () => {
    expect(PluginContributesV2Schema.safeParse({ promptAssets: [{ id: 'external-skills', kind: 'context',
      resource: 'skill-context', target: { kind: 'agent', agent: 'acme-agent' }, adapterDescriptor: {} }] }).success).toBe(false);
  });

  it('keeps descriptor-only prompt assets free of runtime registration demand', () => {
    const parsed = PluginContributesV2Schema.parse({
      promptAssets: [{
        id: 'static-context',
        kind: 'context',
        resource: 'static-context',
        target: { kind: 'agent', agent: 'acme-agent' },
      }],
    });

    expect(derivePluginDaemonContributionRegistrationRights(parsed)).not.toContainEqual(
      expect.objectContaining({ family: 'promptAssets' }),
    );
  });
});
