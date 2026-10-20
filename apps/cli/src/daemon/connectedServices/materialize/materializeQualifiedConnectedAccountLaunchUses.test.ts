import { describe, expect, it, vi } from 'vitest';
import { buildQualifiedPluginContributionKey, PluginAgentContributionV2Schema, PluginManifestV2Schema } from '@happier-dev/protocol';
import { projectAgentConnectedAccountLaunchCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { createConnectedAccountPurposeBindingOwner } from '../purposeBindings/ConnectedAccountPurposeBindingOwner';
import { resolveQualifiedPurposeBindingSnapshotForAgentSpawn } from '../requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/antigravity/src/manifest';
import { antigravityConnectedAccountLaunch } from '../../../../../../packages/plugins/antigravity/src/agent/connectedServices/continuity';
import { antigravityConnectedAccountRuntime } from '../../../../../../packages/plugins/antigravity/src/connectedAccounts/antigravityConnectedAccountRuntime';
import { stripUnsetEnvironmentVariables } from '@/utils/processEnv/buildScopedProcessEnv';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import {
  materializeQualifiedConnectedAccountLaunchUses,
} from './materializeQualifiedConnectedAccountLaunchUses';

const consumer = Object.freeze({
  pluginId: 'acme.example-agent',
  localId: 'example',
});
const service = Object.freeze({
  pluginId: 'acme.example-auth',
  localId: 'account',
});
const purpose = Object.freeze({ consumer, purpose: 'launch' });
const account = Object.freeze({ service, accountId: 'account-1' });

describe('materializeQualifiedConnectedAccountLaunchUses', () => {

  it('consumes the Antigravity producer declaration for connected overrides while preserving a subsequent native launch', async () => {
    const agentId = 'antigravity';
    const declaration = PluginAgentContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.agents?.[0]);
    const identity = { pluginId: PLUGIN_MANIFEST.id, localId: agentId };
    const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'antigravity-account' };
    const account = { service, accountId: 'selected-account' };
    const catalogEntry = projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: identity.pluginId, agentId, isCurrent: () => true,
      hostAccess: PluginManifestV2Schema.parse(PLUGIN_MANIFEST).hostAccess,
      connectedAccountLaunch: antigravityConnectedAccountLaunch,
    });
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [{
          purpose: { consumer: identity, purpose: 'model_upstream' }, target: { kind: 'account', account },
        }] }),
        update: async () => { throw new Error('Launch must not edit Account settings'); },
        subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Launch must not prompt'); },
      resolveTarget: async target => target.kind === 'account'
        ? { displayName: target.account.accountId, account: target.account } : null,
      // The host account boundary invokes the genuine provider materializer.
      materializeAccount: async ({ request, signal }) => antigravityConnectedAccountRuntime.materialize(request, {
        account, plugin: { id: service.pluginId, version: PLUGIN_MANIFEST.version },
        contribution: { id: service.localId, qualifiedId: buildQualifiedPluginContributionKey(service) },
        surface: 'background', invokedAtMs: 0, services: createUnavailablePluginServices(),
        signal, credentials: { async get() { return null; } },
        configuration: { target: { kind: 'account', account, modeId: 'oauth-personal' }, revision: 'configuration-1', values: {}, async getSecret() { return null; } },
      }),
      projectTargetAccounts: async () => { throw new Error('No Account listing needed'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No Account listing needed'); },
    });
    const contributions = { agentDefinitionsById: new Map([[agentId, {
      identity, richDefinition: { definition: declaration }, catalogEntry,
    }]]) };
    const inheritedEnvironment = {
      AGY_ACP_CCPA_BASE_URL: 'https://custom.example', AGY_ACP_CCPA_PROJECT: 'native-project',
      GOOGLE_APPLICATION_CREDENTIALS: '/native/application.json', SHELL: '/bin/zsh',
    };
    const launch = async (source: 'connected' | 'native') => {
      const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId, contributions, bindings: { v: 2, bindingsByServiceId: {
          [buildQualifiedPluginContributionKey(service)]: source === 'connected'
            ? { source, selection: 'profile', profileId: account.accountId } : { source },
        } },
      });
      if (!snapshot) throw new Error('AGY declared launch snapshot unavailable');
      const materialized = await materializeQualifiedConnectedAccountLaunchUses({
        connectedAccountsOwner: owner, snapshot, signal: new AbortController().signal,
      });
      return { ...stripUnsetEnvironmentVariables(inheritedEnvironment, materialized.unsetEnvKeys), ...materialized.env };
    };
    expect(await launch('connected')).toEqual({
      AGY_ACP_FORCE_FILE_STORAGE: '1', GOOGLE_APPLICATION_CREDENTIALS: '/native/application.json', SHELL: '/bin/zsh',
    });
    expect(await launch('native')).toEqual(inheritedEnvironment);
  });

  it('suppresses only declared keys of a bound purpose and preserves explicit native launch environment', async () => {
    const catalogEntry = projectAgentConnectedAccountLaunchCatalogEntry({
      pluginId: consumer.pluginId,
      agentId: 'acme.example' as never,
      isCurrent: () => true,
      connectedAccountLaunch: {
        environmentUnsetUses: [
          { purpose: 'launch', environmentKey: 'AGY_ACP_CCPA_BASE_URL' },
          { purpose: 'launch', environmentKey: 'AGY_ACP_CCPA_PROJECT' },
          { purpose: 'unbound', environmentKey: 'UNRELATED_NATIVE_VALUE' },
        ],
      },
    });
    const owner = createConnectedAccountPurposeBindingOwner({
      store: {
        read: async () => ({ v: 1, bindings: [] }),
        update: async () => { throw new Error('Launch projection must not edit Account settings'); },
        subscribe: () => ({ dispose() {} }),
      },
      selectTarget: async () => { throw new Error('Launch projection must not prompt'); },
      resolveTarget: async target => target.kind === 'account'
        ? { displayName: target.account.accountId, account: target.account } : null,
      materializeAccount: async () => { throw new Error('Unsetting inherited values needs no credential disclosure'); },
      projectTargetAccounts: async () => { throw new Error('No Account listing needed'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No Account listing needed'); },
    });
    const contributions = { agentDefinitionsById: new Map([['acme.example', {
      identity: consumer,
      richDefinition: { definition: { connectedAccounts: [
        { purpose: 'launch', service }, { purpose: 'unbound', service: { ...service, localId: 'other' } },
      ] } },
      catalogEntry,
    }]]) };
    const materialize = async (source: 'connected' | 'native') => {
      const snapshot = resolveQualifiedPurposeBindingSnapshotForAgentSpawn({
        agentId: 'acme.example', contributions,
        bindings: { v: 2, bindingsByServiceId: {
          [buildQualifiedPluginContributionKey(service)]: source === 'connected'
            ? { source, selection: 'profile', profileId: account.accountId } : { source },
        } },
      });
      if (!snapshot) throw new Error('Declared Agent launch snapshot unavailable');
      return await materializeQualifiedConnectedAccountLaunchUses({
        connectedAccountsOwner: owner, snapshot, signal: new AbortController().signal,
      });
    };
    expect(await materialize('connected')).toEqual({
      env: {}, unsetEnvKeys: ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'],
    });
    // A fresh native projection after connected use must not retain purpose-owned removal.
    expect(await materialize('native')).toEqual({ env: {}, unsetEnvKeys: [] });
  });

  it('keeps account selection and credential-file paths in their canonical host owners', async () => {
    const getBinding = vi.fn(async () => ({ account }));
    const materialize = vi.fn(async (input: Readonly<{
      request: Readonly<{ kind: 'environment' | 'files' }>;
    }>) => input.request.kind === 'environment'
      ? { kind: 'environment' as const, env: { EXAMPLE_TOKEN: 'secret' } }
      : { kind: 'files' as const, files: { 'auth.json': new Uint8Array([1, 2, 3]) } });
    const dispose = vi.fn();
    const credentialFileMaterialize = vi.fn(async (input: Readonly<{
      retainCleanup(cleanup: Readonly<{ dispose(): void }>): void;
    }>) => {
      input.retainCleanup({ dispose });
      return {
        pathsByFileId: { '0': '/host-owned/auth.json' },
        dispose,
      };
    });
    const retainedCleanups: Array<Readonly<{ dispose(): void | Promise<void> }>> = [];

    const environment = await materializeQualifiedConnectedAccountLaunchUses({
      connectedAccountsOwner: { getBinding, materialize } as never,
      credentialFileOwner: { materialize: credentialFileMaterialize } as never,
      snapshot: {
        purposes: [purpose],
        bindings: [{ purpose, target: { kind: 'account', account } }],
        environmentUses: [{
          purpose,
          serviceRefs: [service],
          environmentKey: 'EXAMPLE_TOKEN',
        }],
        fileEnvironmentUses: [{
          purpose,
          serviceRefs: [service],
          fileId: 'auth.json',
          environmentKey: 'EXAMPLE_AUTH_FILE',
        }],
      },
      sessionId: 'session-1',
      signal: new AbortController().signal,
      credentialFileScope: {
        occurrenceId: 'generation-1',
        pluginId: consumer.pluginId,
        contributionQualifiedId: 'acme.example-agent/agents/example',
        sessionId: 'session-1',
      },
      retainCredentialFileCleanup(cleanup) {
        retainedCleanups.push(cleanup);
      },
    });

    expect(environment).toEqual({
      env: { EXAMPLE_TOKEN: 'secret', EXAMPLE_AUTH_FILE: '/host-owned/auth.json' },
      unsetEnvKeys: [],
    });
    expect(getBinding).toHaveBeenCalledTimes(1);
    expect(materialize).toHaveBeenCalledTimes(2);
    expect(materialize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      expectedAccount: account,
      request: { kind: 'environment', keys: ['EXAMPLE_TOKEN'] },
    }));
    expect(materialize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      expectedAccount: account,
      request: { kind: 'files', fileIds: ['auth.json'] },
    }));
    expect(credentialFileMaterialize).toHaveBeenCalledWith(expect.objectContaining({
      files: { '0': new Uint8Array([1, 2, 3]) },
    }));
    expect(retainedCleanups).toHaveLength(1);
  });
});
