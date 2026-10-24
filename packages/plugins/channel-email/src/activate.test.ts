import { describe, expect, it } from 'vitest';
import { assertConversationProviderContributionV1 } from '@happier-dev/channels-protocol/testing/v1';
import { assertEmailTransportContributionV1 } from '@happier-dev/email-transports-protocol/testing/v1';
import { PLUGIN_MANIFEST } from './plugin.js';

describe('Email Channels author contract', () => {
  it('contributes one complete Channels provider and the raw transport point', () => {
    assertConversationProviderContributionV1(PLUGIN_MANIFEST);
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toContainEqual(expect.objectContaining({
      target: { pluginId: 'happier.channels', pointId: 'providers' },
      descriptor: { v: 1, displayName: 'Email' },
    }));
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions?.filter((entry) => {
      const target = entry.target;
      return target !== null && typeof target === 'object' && 'pluginId' in target && target.pluginId === 'happier.channels';
    })).toHaveLength(1);
    expect(PLUGIN_MANIFEST.contributes.pluginContributionPoints).toEqual([expect.objectContaining({ id: 'transports' })]);
  });

  it('registers its first-party transport and both Connected Account auth modes', () => {
    assertEmailTransportContributionV1(PLUGIN_MANIFEST);
    expect(PLUGIN_MANIFEST.contributes.targetedPluginContributions).toContainEqual(expect.objectContaining({
      target: { pluginId: 'happier.channel.email', pointId: 'transports' },
      id: 'imap-smtp',
    }));
    expect(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors).toContainEqual(expect.objectContaining({
      id: 'email-imap-smtp', authentication: expect.objectContaining({ modes: expect.arrayContaining([
        expect.objectContaining({ id: 'password' }), expect.objectContaining({ id: 'microsoft-app-only' }),
      ]) }),
    }));
  });
});
