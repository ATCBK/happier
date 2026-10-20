// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginTestkit, createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { describeTriageSourceFailureV1, TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';
import { activate } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { BITBUCKET_PLUGIN_ID } from '../../bitbucketContracts.js';
import { encodeBitbucketConfiguration } from '../../triage/instance.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from '../../triage/source/descriptor.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS, BitbucketBuildsInputV1Schema, BitbucketBuildsResultV1Schema } from '../../triage/source/detailContracts.js';
import { accountRef, createConnectedAccountsStub, createHttpStub } from '../../triage/source/testSupport.js';
import pullRequest from '../../triage/fixtures/pullRequestSelf.json' with { type: 'json' };
import { renderSurface } from '../renderSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
const plugins: Array<Awaited<ReturnType<typeof createPluginTestkit>>> = [];
afterEach(async () => {
  for (const surface of mounted.splice(0)) await act(async () => { await surface.dispose(); });
  for (const plugin of plugins.splice(0)) await plugin.dispose();
});
function launchInput() {
  const workspaceUuid = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid });
  if (!encoded.ok) throw new Error('Expected valid configuration');
  const source = { pluginId: BITBUCKET_PLUGIN_ID, localId: 'bitbucket-forge' };
  return TriageDetailSurfaceInputV1Schema.parse({ v: 1, panel: 'checks',
    instance: { v: 1, instance: { source, sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' },
      binding: { purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE, account: accountRef('account-1') }, localInstanceKey: workspaceUuid, configuration: { v: 1, token: encoded.token } },
    observation: { entryRef: { source, kindId: 'pull-request', collisionScope: `bitbucket:${pullRequest.destination.repository.uuid}`, entryId: '42' },
      observedAtMs: 1_760_000_700_000, locator: { v: 1, routingToken: 'example-workspace/deploy-tools' },
      snapshot: { v: 1, title: 'Read dispatch', scopeLabel: 'example-workspace/deploy-tools', state: { presentation: 'active', nativeLabel: 'Open' }, facts: [] }, viewer: { involvement: [] } }, linkedSessions: [] });
}
async function mountRegisteredBuilds(misbind = false) {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const transport = createHttpStub(url => {
    if (url.includes('/statuses')) return { body: { values: [{ uuid: '{7c0d1e2f-3a4b-4c5d-8e9f-0a1b2c3d4e5f}', key: 'PIPELINE', name: 'Dispatch pipeline', state: 'SUCCESSFUL' }] } };
    if (url.includes('/comments')) return { body: { values: [] } };
    if (url.endsWith('/pullrequests/42')) return { body: pullRequest };
    throw new Error(`Unexpected Bitbucket route: ${url}`);
  });
  const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
    connectedAccounts, http: { ...transport.http, request: async (request, options) => {
      if (request.url.includes('/statuses')) await pending;
      return transport.http.request(request, options);
    } },
  } });
  plugins.push(plugin);
  const producerResults: unknown[] = [];
  let detail!: PluginUiTestkit;
  await act(async () => {
    detail = await createPluginUiTestkit({ identity: { instanceId: 'bitbucket-dispatch', mountNonce: 'bitbucket-dispatch-mount' },
      authorPlugin: { id: BITBUCKET_PLUGIN_ID, version: '0.0.0' }, surface: defineUiSurface(context => {
        const body = renderSurface({ ...context, launchInput: launchInput() });
        if (body !== null && !React.isValidElement(body)) throw new Error('Expected native detail');
        return body;
      }), launchInput: launchInput(), surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input }) => {
        if (typeof action === 'string' || action.pluginId !== BITBUCKET_PLUGIN_ID || input === undefined) throw new Error('Wrong Action owner');
        const builds = action.localId === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listBuilds;
        const request = misbind && builds ? BitbucketBuildsInputV1Schema.parse(input) : null;
        const result = await plugin.invokeAction(request === null ? action.localId : BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.listComments,
          request === null ? input : request, { surface: 'ui' });
        if (builds) producerResults.push(result);
        return result;
      } },
    });
  });
  mounted.push(detail);
  return { detail, producerResults, release };
}
describe('registered Bitbucket detail read dispatch', () => {
  it('retains pending and settled builds across equivalent parsed launch input', async () => {
    const { detail, producerResults, release } = await mountRegisteredBuilds();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await act(async () => { release(); });
    expect(producerResults).toHaveLength(1);
    expect(BitbucketBuildsResultV1Schema.parse(producerResults[0])).toMatchObject({ kind: 'builds', rows: [{ name: 'Dispatch pipeline' }] });
    await expect(detail.getByText('Dispatch pipeline')).resolves.toBeDefined();
    await act(async () => { await detail.updateSurface(createSurfaceContextFixture()); });
    await expect(detail.getByText('Dispatch pipeline')).resolves.toBeDefined();
    expect(producerResults).toHaveLength(1);
  });
  it('rejects a mis-bound registered producer', async () => {
    const { detail, producerResults } = await mountRegisteredBuilds(true);
    expect(producerResults).toHaveLength(1);
    expect(BitbucketBuildsResultV1Schema.safeParse(producerResults[0]).success).toBe(false);
    await expect(detail.getByText(describeTriageSourceFailureV1({ class: 'unsupportedContract', code: 'bitbucket-detail-result-unreadable' }, 'Bitbucket could not complete this read.'))).resolves.toBeDefined();
  });
});
