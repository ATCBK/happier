import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapAcpRegistryAgentToDefinitionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import { AcpRegistryAgentV1Schema } from '@happier-dev/protocol/registries';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

const ACP = 'builtin:acp-registry';
const junie = AcpRegistryAgentV1Schema.parse({
  id: 'junie',
  name: 'Junie',
  version: '3579.5.0',
  description: 'AI coding agent by JetBrains.',
  authors: ['JetBrains'],
  distributions: {
    binary: {
      'darwin-arm64': {
        archiveUrl:
          'https://download.jetbrains.com/junie/junie-3579.5.0-darwin-arm64.tar.gz',
        command: './junie',
        args: ['--acp'],
        env: {},
      },
      'linux-x64': {
        archiveUrl:
          'https://download.jetbrains.com/junie/junie-3579.5.0-linux-x64.tar.gz',
        command: './junie',
        args: ['--acp'],
        env: {},
      },
    },
  },
});
const machines = [
  {
    machineId: 'mbp',
    name: 'MacBook Pro',
    platform: 'darwin',
    arch: 'arm64',
    offline: false,
  },
  {
    machineId: 'nl2',
    name: 'nl2',
    platform: 'linux',
    arch: 'x64',
    offline: false,
  },
  {
    machineId: 'win',
    name: 'Windows desktop',
    platform: 'linux',
    arch: 'x64',
    offline: true,
  },
  {
    machineId: 'pi',
    name: 'Pi',
    platform: 'linux',
    arch: 'riscv64',
    offline: false,
  },
] as const;

/** The Action's real output for this item: the definition the registry mapper writes, and one job per machine. */
function installed(installOn: readonly string[]) {
  const mapped = mapAcpRegistryAgentToDefinitionV1({
    agent: junie,
    nowMs: 1,
    provenance: {
      sourceId: ACP,
      format: 'acp-registry',
      sourceUrl:
        'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
      itemId: 'junie',
      ref: { kind: 'version', version: junie.version },
      importedAt: 1,
    },
  });
  if (!mapped.ok) throw new Error('mapping failed');
  return {
    ok: true as const,
    result: {
      definition: mapped.definition,
      jobs: installOn.map((machineId) => ({
        machineId,
        jobId: `job-${machineId}`,
      })),
    },
  };
}

describe('addRegistryAgent', () => {
  it('confirms once, naming machines installing now and on first use, then adds and installs in one Action and stays', async () => {
    const { addRegistryAgent } = await import('./agentAddModalConfig');
    const confirm = vi.fn(async () => true);
    const execute = vi.fn(async (_id: string, input: unknown) =>
      installed((input as { installOn?: string[] }).installOn ?? []),
    );
    const added = await addRegistryAgent({
      row: { sourceId: ACP, itemId: 'junie' },
      agent: junie,
      machines,
      choice: 'now',
      execute: execute as never,
      confirm,
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    // The offline machine that can run it installs when a session first uses it; the one with no build is not named.
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Junie',
        version: '3579.5.0',
        nowMachines: ['MacBook Pro', 'nl2'],
        firstUseMachines: ['Windows desktop'],
        sourceHost: 'download.jetbrains.com',
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      'agents.acp.backends.installFromRegistry',
      {
        fromRegistry: { sourceId: ACP, itemId: 'junie', version: '3579.5.0' },
        installOn: ['mbp', 'nl2'],
      },
      {
        presentUserConfirmation: {
          actionId: 'agents.acp.backends.installFromRegistry',
        },
      },
    );
    expect(added).toEqual({
      definitionId: installed([]).result.definition.id,
      installOn: ['mbp', 'nl2'],
    });
  });

  it('On first use starts no job, and a declined confirm changes nothing', async () => {
    const { addRegistryAgent } = await import('./agentAddModalConfig');
    const execute = vi.fn(async (_id: string, _input: unknown) => installed([]));
    const firstUse = await addRegistryAgent({
      row: { sourceId: ACP, itemId: 'junie' },
      agent: junie,
      machines,
      choice: 'firstUse',
      execute: execute as never,
      confirm: async () => true,
    });
    expect(execute.mock.calls[0]?.[1]).toEqual({
      fromRegistry: { sourceId: ACP, itemId: 'junie', version: '3579.5.0' },
    });
    expect(firstUse?.installOn).toEqual([]);

    const declinedExecute = vi.fn(async (_id: string, _input: unknown) => installed([]));
    const declined = await addRegistryAgent({
      row: { sourceId: ACP, itemId: 'junie' },
      agent: junie,
      machines,
      choice: 'now',
      execute: declinedExecute as never,
      confirm: async () => false,
    });
    expect(declined).toBeNull();
    expect(declinedExecute).not.toHaveBeenCalled();
  });
});

describe('the Adding details', () => {
  it('follows each machine’s job: waiting, downloading with bytes, checking, installed, failed, cancelled, offline, first use', async () => {
    const { presentAgentInstallProgress } =
      await import('./AgentAddingProgress');
    const step = (
      state: 'running' | 'done',
      bytesDone: number | null,
      bytesTotal: number | null,
    ) => ({
      stepId: 'download',
      label: 'Download',
      state,
      bytesDone,
      bytesTotal,
    });
    const job = (
      steps: ReturnType<typeof step>[],
      outcome: unknown = null,
    ) => ({
      jobId: 'j',
      intent: 'install' as const,
      startedAtMs: 1,
      logLine: null,
      steps,
      outcome: outcome as never,
    });
    expect(
      presentAgentInstallProgress({
        job: null,
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'waiting' });
    expect(
      presentAgentInstallProgress({
        job: null,
        installingNow: false,
        offline: false,
      }),
    ).toEqual({ phase: 'firstUse' });
    expect(
      presentAgentInstallProgress({
        job: null,
        installingNow: false,
        offline: true,
      }),
    ).toEqual({ phase: 'offline' });
    expect(
      presentAgentInstallProgress({
        job: job([step('running', 76e6, 118e6)]),
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'downloading', bytesDone: 76e6, bytesTotal: 118e6 });
    expect(
      presentAgentInstallProgress({
        job: job([
          step('done', 118e6, 118e6),
          { ...step('running', null, null), stepId: 'verify' },
        ]),
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'checking' });
    expect(
      presentAgentInstallProgress({
        job: job([], { kind: 'succeeded', version: '3579.5.0' }),
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'installed' });
    expect(
      presentAgentInstallProgress({
        job: job([], {
          kind: 'failed',
          code: 'download_failed',
          stepId: 'download',
          message: 'Connection reset',
        }),
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'failed', message: 'Connection reset' });
    expect(
      presentAgentInstallProgress({
        job: job([], {
          kind: 'failed',
          code: 'cancelled',
          stepId: 'download',
          message: 'Cancelled',
        }),
        installingNow: true,
        offline: false,
      }),
    ).toEqual({ phase: 'cancelled' });
  });

  it('keeps Try again on a failed machine and Cancel on a downloading one reachable', async () => {
    const { AgentInstallProgressItem } = await import('./AgentAddingProgress');
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const screen = await renderScreen(
      <>
        <AgentInstallProgressItem
          machine={machines[0]}
          progress={{ phase: 'failed', message: 'Connection reset' }}
          onRetry={onRetry}
          onCancel={onCancel}
          testID="mbp"
        />
        <AgentInstallProgressItem
          machine={machines[1]}
          progress={{
            phase: 'downloading',
            bytesDone: 76e6,
            bytesTotal: 118e6,
          }}
          onRetry={onRetry}
          onCancel={onCancel}
          testID="nl2"
        />
      </>,
    );
    const press = async (testID: string) => {
      const node = screen.findAll(
        (candidate) =>
          candidate.props?.testID === testID &&
          typeof candidate.props?.onPress === 'function',
      )[0];
      if (!node) throw new Error(`${testID} is not pressable`);
      await act(async () => {
        node.props.onPress();
      });
    };
    await press('mbp.retry');
    await press('nl2.cancel');
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      screen.findAll((node) => node.props?.testID === 'nl2.cancel').length,
    ).toBeGreaterThan(0);
    expect(
      screen.findAll((node) => node.props?.testID === 'mbp.cancel'),
    ).toHaveLength(0);
  });
});

const npmSource = {
  id: 'marketplace:community-npm',
  title: 'Community npm',
  kind: 'community-npm' as const,
  sourceUrl: 'https://registry.npmjs.org',
};
async function pluginItem() {
  const { MarketplaceIndexEntryV1Schema } = await import('@happier-dev/protocol/marketplace');
  const { RegistryItemV1Schema } = await import('@happier-dev/protocol/registries');
  const listing = MarketplaceIndexEntryV1Schema.parse({
    pluginId: 'halvard.aider',
    publisher: { id: 'halvard-dev', displayName: 'halvard-dev' },
    display: { title: 'Aider', description: 'Pair programming in your terminal.' },
    distribution: {
      kind: 'npm',
      registryOrigin: 'https://registry.npmjs.org',
      packageName: 'happier-plugin-aider',
      version: '0.4.2',
      integrity: `sha512-${'A'.repeat(86)}==`,
    },
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    compatibility: { platforms: ['darwin', 'linux'] },
    summary: { contributions: ['agents', 'actions'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
    review: { status: 'unreviewed', reviewedAt: null },
    categories: [],
    media: [],
    updatePolicy: 'allowed',
    links: {},
  });
  return RegistryItemV1Schema.parse({
    summary: { sourceId: npmSource.id, kind: 'plugin', itemId: 'happier-plugin-aider', title: 'Aider', version: '0.4.2' },
    payload: { kind: 'plugin', listing, source: npmSource },
    fetchedAt: 1,
  });
}

const pressable = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => {
  const node = screen.findAll(
    (candidate) => candidate.props?.testID === testID && typeof candidate.props?.onPress === 'function',
  )[0];
  if (!node) throw new Error(`${testID} is not pressable`);
  return node;
};

describe('the alternate Add-an-agent branches', () => {
  it('a plugin listing shows what it adds, the trusted-code facts and the machine it installs on', async () => {
    const { AgentPluginDetail } = await import('./AgentRegistryDetail');
    const { createMachineAdministrationTargetSelectionFixture } = await import('@/dev/testkit/mocks/machineAdministrationTargetSelection');
    const item = await pluginItem();
    const screen = await renderScreen(
      <AgentPluginDetail
        item={item}
        sourceTitle="Community npm"
        targetSelection={createMachineAdministrationTargetSelectionFixture({
          machines: [{ machineId: 'mbp', displayName: 'MacBook Pro' }],
        })}
        testID="agents.add"
      />,
    );
    const ids = new Set(screen.findAll((node) => typeof node.props?.testID === 'string').map((node) => node.props.testID));
    expect(ids.has('agents.add.detail.plugin.adds')).toBe(true);
    expect(ids.has('agents.add.detail.plugin.trust')).toBe(true);
    expect(ids.has('agents.add.detail.plugin.target.current')).toBe(true);
  });

  it('a built-in agent offers the registry’s version as a separate agent', async () => {
    const { AgentBuiltInDetail } = await import('./AgentRegistryDetail');
    const onAddSeparate = vi.fn();
    const screen = await renderScreen(
      <AgentBuiltInDetail
        row={{
          key: 'k',
          pick: false,
          summary: { sourceId: ACP, kind: 'agent', itemId: 'claude-agent', title: 'Claude Agent', version: '0.89.1' },
          status: null,
        }}
        entry={{ agentId: 'claude', title: 'Claude Code' } as never}
        sourceTitle="ACP Registry"
        onAddSeparate={onAddSeparate}
        testID="agents.add"
      />,
    );
    await act(async () => {
      pressable(screen, 'agents.add.detail.addSeparate').props.onPress();
    });
    expect(onAddSeparate).toHaveBeenCalledTimes(1);
  });

  it('an empty plugin source leads to the ACP Registry and to publishing; a query keeps Clear', async () => {
    const { AgentCatalogEmpty } = await import('./agentAddModalConfig');
    const onBrowseRegistry = vi.fn();
    const onClear = vi.fn();
    const empty = await renderScreen(
      <AgentCatalogEmpty query="" pluginSource onClear={onClear} onBrowseRegistry={onBrowseRegistry} />,
    );
    await act(async () => {
      pressable(empty, 'agents.add.empty.browseRegistry').props.onPress();
    });
    expect(onBrowseRegistry).toHaveBeenCalledTimes(1);
    expect(empty.findAll((node) => node.props?.testID === 'agents.add.empty.publish').length).toBeGreaterThan(0);

    const searched = await renderScreen(
      <AgentCatalogEmpty query="aid" pluginSource onClear={onClear} onBrowseRegistry={onBrowseRegistry} />,
    );
    expect(searched.findAll((node) => node.props?.testID === 'agents.add.empty.browseRegistry')).toHaveLength(0);
    await act(async () => {
      pressable(searched, 'agents.add.empty.clear').props.onPress();
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
