import { describe, expect, it } from 'vitest';

import { ConnectedAccountUiProjectionEntryV1Schema, projectConnectedAccountDescriptorV1 } from './connectedAccountUiProjectionV1.js';
import { PluginConnectedAccountDescriptorContributionV2Schema } from './pluginConnectedAccountAuthenticationV2.js';

describe('ConnectedAccountUiProjectionEntryV1', () => {
  it('projects optional Cloud machines presentation from an external descriptor without granting availability', () => {
    const raw = { id: 'cloud', title: 'Acme Cloud', ui: { category: 'cloud-machines' }, authentication: {
      defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }],
    } };
    const declared = PluginConnectedAccountDescriptorContributionV2Schema.safeParse(raw);
    expect(declared.success).toBe(true);
    if (!declared.success) return;
    const projected = projectConnectedAccountDescriptorV1({ descriptor: declared.data, pluginId: 'acme.cloud', serviceId: 'cloud',
      provenance: 'external', sourceKind: 'installed', availability: { state: 'blocked', reason: 'configuration-required' }, diagnostics: [] });
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(projected)).toMatchObject({ ui: { category: 'cloud-machines' },
      availability: { state: 'blocked', reason: 'configuration-required' } });
    expect(PluginConnectedAccountDescriptorContributionV2Schema.safeParse({ ...raw, ui: { category: 'cloud-machines', execute: 'hook' } }).success).toBe(false);
  });
  it('preserves every serializable authentication mode and configuration form fact', () => {
    const input = {
      id: 'bitbucket-account', serviceId: 'bitbucket', pluginId: 'happier.scm.forge.bitbucket', provenance: 'external', sourceKind: 'bundled',
      title: 'Bitbucket account',
      authentication: {
        defaultModeId: 'manual',
        modes: [{
          id: 'manual',
          kind: 'manual',
          outcomeReconciliation: 'none',
          fields: [{
            id: 'token',
            title: 'Token',
            schema: { type: 'string', minLength: 1 },
            secret: true,
          }],
        }, {
          id: 'device',
          kind: 'oauthDeviceCode',
          outcomeReconciliation: 'providerCheck',
          scopes: ['account.read'],
          configuration: {
            scope: 'account',
            changeBehavior: 'refresh',
            fields: [{
              id: 'tenant',
              title: 'Tenant',
              schema: { type: 'string', minLength: 1 },
              secret: false,
              default: 'main',
              required: true,
              presentation: { control: 'text' },
            }],
          },
        }],
      },
      capabilities: [],
      recoveryCredits: { supported: true },
      billingUrl: 'https://provider.test/billing',
      availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    };
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(input)).toEqual(input);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, billingUrl: undefined }).success).toBe(true);
    expect(ConnectedAccountUiProjectionEntryV1Schema.parse(input).authentication.modes).toHaveLength(2);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, hookKey: 'execute-me' }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          ...input.authentication.modes[1],
          configuration: {
            ...input.authentication.modes[1]?.configuration,
            fields: [{
              id: 'clientSecret',
              title: 'Client secret',
              schema: { type: 'string' },
              secret: true,
              value: 'must-not-project',
            }],
          },
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          id: 'oauth',
          kind: 'oauthAuthorizationCode',
          callbackUrl: 'https://provider.example/oauth/callback',
          pkce: 'required',
          outcomeReconciliation: 'none',
          clientSecretEnvKey: 'OAUTH_CLIENT_SECRET',
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({
      ...input,
      authentication: {
        ...input.authentication,
        modes: [{
          id: 'legacy',
          kind: 'hostAdapter',
          adapter: 'githubOAuth',
        }],
      },
    }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, pluginId: '../bad-plugin' }).success).toBe(false);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, serviceId: 'forge' }).success).toBe(true);
    expect(ConnectedAccountUiProjectionEntryV1Schema.safeParse({ ...input, pluginId: undefined, serviceId: 'unregistered-service' }).success).toBe(false);
  });
});
