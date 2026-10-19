// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginTestkit,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { describeTriageSourceFailureV1, TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../../triage/configuration.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { GithubChangedFilesInputV1Schema, GithubChangedFilesResultV1Schema } from '../../triage/detail/contracts.js';
import { GITHUB_FIXTURE_REPOSITORY_ID, githubChangedFile } from '../../triage/__fixtures__/githubResponses.js';
import { createStubGithubTransport, type StubHttpResponse } from '../../triage/testkit/githubTriage.test-support.js';
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(async () => { await surface.dispose(); });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});

function launchInput() {
  const source = { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' };
  const token = encodeGithubTriageConfiguration({ v: 1,
    scope: { kind: 'repository', repositoryKey: 'octo-org/example-app' } });
  if (token === null) throw new Error('Expected valid GitHub configuration');
  return TriageDetailSurfaceInputV1Schema.parse({
    v: 1,
    panel: 'files',
    instance: {
      v: 1,
      instance: { source, sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70' },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: {
        service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }, accountId: 'account-under-test',
      } },
      localInstanceKey: 'github.com',
      configuration: { v: 1, token },
    },
    observation: {
      entryRef: { source, kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' },
      observedAtMs: 1_760_000_700_000,
      locator: { v: 1, routingToken: 'octo-org/example-app' },
      snapshot: { v: 1, title: 'Consolidate the duplicated normalizer', scopeLabel: 'octo-org/example-app',
        state: { presentation: 'active', nativeLabel: 'Open' }, facts: [] },
      viewer: { involvement: [] },
    },
    linkedSessions: [],
  });
}

async function mountRegisteredFiles(options: Readonly<{ misbind?: boolean }> = {}) {
  let release!: (response: StubHttpResponse) => void;
  const pending = new Promise<StubHttpResponse>(resolve => { release = resolve; });
  const transport = createStubGithubTransport({ respond: request => request.url.includes('/files?') ? pending : undefined });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
    http: transport.context.services.http,
    connectedAccounts: transport.context.services.connectedAccounts,
  } });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({
      identity: { instanceId: 'github-read-dispatch', mountNonce: 'github-read-dispatch-mount' },
      authorPlugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      // A host context update reparses the same navigation value, just as the
      // targeted renderer receives new launch objects from the parent surface.
      surface: defineUiSurface(context => {
        const body = renderSurface({ ...context, launchInput: launchInput() });
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected a React-native surface');
        return body;
      }),
      launchInput: launchInput(),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input }) => {
        if (typeof action === 'string' || action.pluginId !== GITHUB_PLUGIN_ID) throw new Error('Wrong Action owner');
        if (input === undefined) throw new Error('GitHub detail reads require an input');
        const misbound = options.misbind && action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles;
        const filesRequest = misbound ? GithubChangedFilesInputV1Schema.parse(input) : null;
        const result = await plugin.invokeAction(misbound
          ? GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities : action.localId,
        filesRequest === null ? input : { v: 1, instance: filesRequest.instance, localRef: filesRequest.localRef,
          routingToken: filesRequest.routingToken }, { surface: 'ui' });
        if (action.localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles) producerResults.push(result);
        return result;
      } },
    });
  });
  mounted.push(detail);
  return { detail, transport, producerResults, release };
}

describe('registered GitHub detail read dispatch', () => {
  it('keeps a real pending read across reparsed launch input and populates the mounted panel', async () => {
    const { detail, transport, producerResults, release } = await mountRegisteredFiles();
    expect(transport.requests.some(request => request.url.includes('/files?'))).toBe(true);
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { release({ status: 200, body: [githubChangedFile({ filename: 'src/dispatch.ts' })] }); });
    expect(producerResults).toHaveLength(1);
    expect(GithubChangedFilesResultV1Schema.parse(producerResults[0])).toMatchObject({
      kind: 'changedFiles', rows: [{ path: 'src/dispatch.ts' }],
    });
    // File titles retain both path halves in separate text runs for middle ellipsis.
    expect(document.body.textContent).toContain('src/dispatch.ts');
    // A settled host update must retain the same page rather than re-read it.
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    expect(document.body.textContent).toContain('src/dispatch.ts');
    expect(producerResults).toHaveLength(1);
  });

  it('refuses a mis-bound registered producer rather than presenting its result as files', async () => {
    const { detail, producerResults } = await mountRegisteredFiles({ misbind: true });
    await expect(detail.queryByText('src/dispatch.ts')).resolves.toBeUndefined();
    expect(producerResults).toHaveLength(1);
    expect(GithubChangedFilesResultV1Schema.safeParse(producerResults[0]).success).toBe(false);
    await expect(detail.getByText(describeTriageSourceFailureV1({
      class: 'unsupportedContract', code: 'github-detail-result-unreadable',
    }, 'GitHub could not complete this read.'))).resolves.toBeDefined();
  });
});
