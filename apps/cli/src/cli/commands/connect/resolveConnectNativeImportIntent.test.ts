import { describe, expect, it } from 'vitest';
import { PluginConnectedAccountDescriptorContributionV2Schema } from '@happier-dev/protocol/connect/plugin-connected-account-authentication-v2';
import { resolveConnectNativeImportIntent } from './resolveConnectNativeImportIntent';

function modes(sources: string[]) {
  return PluginConnectedAccountDescriptorContributionV2Schema.parse({
    id: 'synthetic-service', title: 'Synthetic service',
    authentication: { defaultModeId: 'oauth', modes: [
      { id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'https://provider.example/oauth/callback', scopes: [], pkce: 'required', outcomeReconciliation: 'none' },
      { id: 'native-import', kind: 'manual', outcomeReconciliation: 'none', fields: [
        { id: 'source', title: 'Native login source', secret: false, schema: { type: 'string', enum: sources } },
      ] },
    ] },
  }).authentication.modes;
}

describe('native import CLI acquisition intent', () => {
  it('chooses declared native acquisition and its only source without prompting', () => {
    expect(resolveConnectNativeImportIntent(modes(['native']), null)).toEqual({ modeId: 'native-import', fields: { source: 'native' } });
  });
  it('uses only an explicitly selected declared source when several native stores exist', () => {
    expect(resolveConnectNativeImportIntent(modes(['acp', 'cli', 'cli-file']), 'cli-file')).toEqual({ modeId: 'native-import', fields: { source: 'cli-file' } });
    expect(() => resolveConnectNativeImportIntent(modes(['acp', 'cli']), null)).toThrow();
    expect(() => resolveConnectNativeImportIntent(modes(['native']), '/private/arbitrary/path')).toThrow();
  });
  it('does not substitute ordinary OAuth when native import is undeclared', () => {
    expect(() => resolveConnectNativeImportIntent(modes(['native']).filter(mode => mode.id !== 'native-import'), 'native')).toThrow();
  });
});
