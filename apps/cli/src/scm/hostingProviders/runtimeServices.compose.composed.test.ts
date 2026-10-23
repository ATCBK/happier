import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';
import {
  PluginConnectedAccountDescriptorContributionV2Schema,
  ScmHostingProviderContributionSchema,
  type QualifiedConnectedAccountPurposeBindingsV1,
} from '@happier-dev/protocol';
import { ScmPullRequestOpenComposeResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import {
  GITHUB_SCM_HOSTING_PROVIDER_ID,
  PLUGIN_MANIFEST,
  githubHostingProviderAdapter,
  githubPullRequestAdapter,
} from '@happier-dev/plugins-scm-github';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createHostScmHostingProviderRuntimeServices } from './runtimeServices';
import { createGitPullRequestReadOperations } from '../../../../../packages/plugins/scm-git/src/operations/pullRequestReadOperations';
import { runWithRealGitScmRuntime } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';

it('composes from one authorized hosting inventory observation through real Git and the host registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-compose-inventory-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git'], { cwd: root });
    const service = { pluginId: PLUGIN_MANIFEST.id, localId: 'github-account' };
    const account = { service, accountId: 'bound-account' };
    let bindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [{
      purpose: { consumer: { pluginId: PLUGIN_MANIFEST.id, localId: 'github' }, purpose: 'authentication' },
      target: { kind: 'account', account },
    }] };
    let metadataReads = 0;
    const owner = createConnectedAccountPurposeBindingOwner({
      // Only persistence and external Account metadata are substituted. The
      // purpose owner, host registry, forge routing and Git snapshot remain real.
      store: { read: async () => bindings,
        update: async mutate => { bindings = mutate(bindings); return bindings; },
        subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Compose cannot select an Account'); },
      resolveTarget: async () => ({ displayName: 'Bound Account', account }),
      assertTargetAccountMaterializable: async () => undefined,
      materializeAccount: async () => { throw new Error('Compose cannot materialize credentials'); },
      projectTargetAccounts: async () => {
        metadataReads += 1;
        return { status: 'complete', accounts: [{ account, displayName: 'Bound Account', state: 'connected',
          connectedAccountOrigins: ['https://github.com'], connectedAccountBases: ['https://github.com'] }] };
      },
    });
    const services = createHostScmHostingProviderRuntimeServices({
      contributes: {
        scmHostingProviders: [{ id: 'github', provenance: 'external', source: { kind: 'path' },
          pluginId: PLUGIN_MANIFEST.id,
          definition: ScmHostingProviderContributionSchema.parse(PLUGIN_MANIFEST.contributes.scmHostingProviders![0]) }],
        connectedAccountDescriptors: [{ provenance: 'external', source: { kind: 'path' }, pluginId: PLUGIN_MANIFEST.id,
          definition: PluginConnectedAccountDescriptorContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.connectedAccountDescriptors![0]) }],
      },
      scmHostingProvidersById: new Map([[GITHUB_SCM_HOSTING_PROVIDER_ID, { pluginId: PLUGIN_MANIFEST.id,
        occurrenceId: 'compose-fixture', registration: { id: 'github', adapter: {
          routing: githubHostingProviderAdapter, pullRequests: githubPullRequestAdapter,
        } } }]]),
      resolveConnectedAccountPurposeBindingOwner: () => owner,
    });
    const result = await runWithRealGitScmRuntime(() => createGitPullRequestReadOperations().openCompose({
      context: { cwd: root, projectKey: `compose:${root}`, detection: { isRepo: true, rootPath: root, mode: '.git' } },
      request: { base: 'main', head: 'feature/compose' },
    }), { hostingProviderRuntimeServices: services });
    expect(ScmPullRequestOpenComposeResponseSchema.parse(result)).toMatchObject({ success: true,
      composeUrl: 'https://github.com/happier-dev/happier/compare/main...feature%2Fcompose' });
    // This transport workload is the measured cost, not incidental helper calls.
    expect(metadataReads).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
