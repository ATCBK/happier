import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
  ProviderConnectionsCatalogV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import {
  createProviderModelProjectionFixture,
  createProviderModelProjectionGroupFixture,
  createProviderSettingsAccountHarness,
  installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

// Machine transport is the boundary held open here; the Account, Action, projection and
// confirmation owners are the real ones, and the real picker renders inside the modal host.
const { describeProviderModels, seen } = vi.hoisted(() => ({ seen: [] as string[],
  describeProviderModels: vi.fn(),
}));
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: (request: Readonly<{ payload: unknown }>) =>
      (seen.push(JSON.stringify(request).slice(0, 300)), describeProviderModels(request.payload)),
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);
const navigation = createExpoRouterMock();
vi.doMock('expo-router', () => navigation.module);
const account = createProviderSettingsAccountHarness();
await loadSyncSingletonForTests();

const { useExactModelChoice } = await import('./useExactModelChoice');
const { ModalProvider } = await import('@/modal');
const { useFeatureEnabled } = await import('@/hooks/server/useFeatureEnabled');
const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');

const agentTargetKey = 'agent:happier.agent.codex/codex';
const ref = {
  agentTargetKey,
  providerConnectionId: 'pc_experimental',
  modelId: 'deepseek-v4-flash',
} as const;
const optionTestId = `model-picker-overlay-option:${JSON.stringify([agentTargetKey, ref.providerConnectionId, ref.modelId])}`;
const catalog = ProviderConnectionsCatalogV1Schema.parse({
  ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
  connections: [
    {
      v: 1,
      id: ref.providerConnectionId,
      source: {
        kind: 'contribution',
        contributionKey: 'happier.provider.deepseek/deepseek',
      },
      role: 'named',
      displayName: 'DeepSeek',
      displayNameMode: 'custom',
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    },
  ],
});

function experimentalProjection() {
  return createProviderModelProjectionFixture({
    agentTargetKey,
    groups: [
      createProviderModelProjectionGroupFixture({
        connectionId: ref.providerConnectionId,
        connectionRevision: 3,
        providerName: 'DeepSeek',
        connectionName: 'DeepSeek',
        rows: [
          {
            ref,
            descriptor: { id: ref.modelId, name: 'V4 Flash' },
            confidence: 'account_unverified',
            loadState: 'unknown',
            visibility: 'visible',
            sources: { manual: true, static: false, probe: false },
            endpointHealth: 'not_checked',
            catalog: { stale: false },
            compatibility: {
              compatibilityFingerprint: 'compatibility:v1:experimental',
              confirmed: false,
              result: {
                status: 'experimental' as const,
                selectedProtocol: 'openai-responses' as const,
                reasons: ['compatibility_evidence_missing' as const],
                confirmationScope: {
                  kind: 'model' as const,
                  modelId: ref.modelId,
                },
              },
            },
          },
        ],
      }),
    ],
  });
}

let diag: unknown = null;
let probe = '';
let open: ((onSelect: (selection: unknown) => void) => void) | null = null;
function Host(props: Readonly<{ serverId: string }>) {
  const choice = useExactModelChoice({
    agentTargetKey,
    agentId: null,
    machineId: 'machine-a',
    serverId: props.serverId,
    selected: null,
    title: 'Model',
    fallbackLabel: 'Choose',
  });
  const client = useProviderActionClient(props.serverId);
  React.useEffect(() => { void client.describeProviderModels({ machineId: 'machine-a', serverId: props.serverId, agentTargetKey, mode: 'picker' }).catch((e: unknown) => { probe = JSON.stringify(e).slice(0, 800); }); }, [client.ready]);
  open = choice.open;
  diag = { loading: choice.loading, error: choice.error, providers: useFeatureEnabled('providers', { scopeKind: 'spawn', serverId: props.serverId }) };
  return null;
}

beforeEach(async () => {
  standardCleanup();
  await account.reset();
  describeProviderModels.mockReset();
  open = null;
});
afterEach(async () => {
  standardCleanup();
  await account.reset();
});

describe('useExactModelChoice dialog', () => {
  it('follows the projection that settles after the dialog opened, in the same dialog', async () => {
    const { serverId } = await account.restore({ waivedActions: ['providers.models.refresh'] });
    const held: { settle: ((value: unknown) => void) | null } = { settle: null };
    describeProviderModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          held.settle = resolve;
        }),
    );
    const screen = await renderScreen(
      <ModalProvider>
        <Host serverId={serverId} />
      </ModalProvider>,
    );
    await vi.waitFor(async () => { await act(async () => {}); expect(held.settle, JSON.stringify([diag, seen, probe])).not.toBeNull(); }, { timeout: 8000 });
    await act(async () => {
      open!(vi.fn());
    });
    expect(screen.findByTestId(optionTestId)).toBeNull();
    await act(async () => {
      held.settle!(experimentalProjection());
    });
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId(optionTestId)).not.toBeNull(),
    );
  });

  it('shows the approval a selected experimental model waits on in place, without reopening', async () => {
    const { serverId } = await account.restore({ catalog, waivedActions: ['providers.models.refresh'] });
    installProviderConnectionsCatalogHttpBoundary({
      home: account.home,
      serverId,
      catalog,
    });
    await account.home.requireUiApproval(
      serverId,
      'providers.models.experimental.confirm',
    );
    describeProviderModels.mockResolvedValue(experimentalProjection());
    const screen = await renderScreen(
      <ModalProvider>
        <Host serverId={serverId} />
      </ModalProvider>,
    );
    await act(async () => {
      open!(vi.fn());
    });
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId(optionTestId),
        JSON.stringify({ text: screen.getTextContent(), rpc: describeProviderModels.mock.calls.length }),
      ).not.toBeNull(),
    );
    await screen.pressByTestIdAsync(optionTestId);
    await waitForHomeGovernance(() =>
      expect(account.home.artifacts(serverId).list()).toHaveLength(1),
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('model-picker-experimental-approval'),
      ).not.toBeNull(),
    );
  });
});
