import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';

import { buildLocalServiceInventoryRow } from '@/dev/testkit/fixtures/localServices';

import {
  createProcessesAnswer,
  processRow,
  PROCESSES_FIXTURE_BYTES,
} from './testkit/processesAnswerFixture';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the machine network is replaced; credential binding, the process store, Actions, approval policy and the tab run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.rpc);
  },
);
vi.mock('@/modal', async () => {
  const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
  return createModalModuleMock({ renderCustomModals: true }).module;
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { ModalProvider } = await import('@/modal');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { machineProcessesStore } =
  await import('@/sync/domains/machines/processes/machineProcessesStore');
const { MachinePageStateContext } =
  await import('@/components/machines/page/machinePageContext');
const { MachineProcessesTab } = await import('./MachineProcessesTab');
const { measureMountedCollections } = await import('@/dev/testkit/render/renderInCollectionLayout');
const { PROCESS_ROW_EXIT_MS } = await import('./processesMotion');

const { GB, MB } = PROCESSES_FIXTURE_BYTES;

function machine(overrides: Partial<Machine> = {}): Machine {
  return createMachineFixture({
    id: 'machine',
    activeAt: Date.now(),
    storageMode: 'plain',
    isShared: false,
    metadata: {
      host: 'leeroy-mbp',
      platform: 'darwin',
      happyCliVersion: '0.3.0',
      happyHomeDir: '/Users/leeroy/.happier',
      homeDir: '/Users/leeroy',
    },
    access: {
      role: 'manage',
      custodian: { accountId: 'owner', displayName: 'Owner' },
      resourceMode: 'plain',
      accessState: 'ready',
    },
    daemonState: {
      resources: {
        v: 1,
        vitals: { state: 'reporting' },
        host: { logicalCores: 18, memoryTotalBytes: 128 * GB, bootedAt: 1 },
        attention: { level: 'calm', reasons: [] },
      },
    },
    ...overrides,
  });
}

type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;

async function mount(
  options: Readonly<{
    answer?: MachineProcessesAnswerV1;
    reply?: (rpc: Rpc) => unknown;
    machine?: Partial<Machine>;
    params?: Extract<MachinePageTabParams, { id: 'processes' }>;
    online?: boolean;
    waitForRows?: boolean;
  }> = {},
) {
  const serverId = await home.addHome({
    name: 'Processes Home',
    serverUrl: `https://processes-tab-${Math.random().toString(36).slice(2)}.test`,
    accountId: 'owner',
  });
  // The person waived confirmation for these Actions on this device (their own approval setting, R41).
  home.answer(serverId, '/v2/account/settings', {
    body: {
      content: {
        t: 'plain',
        v: {
          actionsSettingsV1: {
            v: 1,
            actions: {},
            approvalWaivedSurfaces: {
              'machines.processes.stop': ['ui'],
              'machines.processes.kill': ['ui'],
              'machines.processes.leftBehind.cleanUp': ['ui'],
              'localServices.actions.terminateDetected': ['ui'],
              'localServices.actions.copyUrl': ['ui'],
            },
          },
        },
      },
      version: 1,
    },
  });
  const current = machine(options.machine);
  storage.setState({
    machines: {},
    machineListByServerId: { [serverId]: [current] },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
  const answer = options.answer ?? createProcessesAnswer();
  transport.rpc.mockImplementation(async (rpc: Rpc) => {
    const reply = options.reply?.(rpc);
    if (reply !== undefined) return reply;
    if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) return answer;
    return new Promise(() => {});
  });
  const pageState = {
    target: {
      machineId: 'machine',
      requestedServerId: serverId,
      serverId,
      activeServerId: serverId,
      machine: current,
      machineName: 'leeroy-mbp',
      online: options.online ?? true,
      isServerSwitching: false,
      isHydratingMachine: false,
      switchReady: true,
    },
    managedEnrolled: null,
    refreshKey: 0,
    reload: async () => {},
  } as unknown as React.ContextType<typeof MachinePageStateContext>;
  const setParams = vi.fn();
  const screen = await renderScreen(
    <AuthProvider initialCredentials={{ token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature` }}>
<ModalProvider>
      <MachinePageStateContext.Provider value={pageState}>
        <MachineProcessesTab
          serverId={serverId}
          machineId="machine"
          machineName="leeroy-mbp"
          online={options.online ?? true}
          params={options.params ?? { id: 'processes' }}
          setParams={setParams}
        />
      </MachinePageStateContext.Provider>
    </ModalProvider>
    </AuthProvider>,
  );
  if (options.waitForRows !== false) await act(async () => {
    await vi.waitFor(() =>
      expect(
        screen.root.findAll((node) => String(node.props.testID ?? '').startsWith('machine-processes-row-')).length,
      ).toBeGreaterThan(0),
    );
  });
  // A test renderer never lays out: measure the table the way the platform does on its first layout.
  await measureMountedCollections(screen, { width: 1200 });
  return { screen, serverId, setParams };
}

const textOf = (node: { children: unknown[] } | null): string =>
  !node
    ? ''
    : node.children
        .map((child) =>
          typeof child === 'string'
            ? child
            : textOf(child as { children: unknown[] }),
        )
        .join('');
const count = (text: string, needle: string) => text.split(needle).length - 1;
type Screen = Awaited<ReturnType<typeof mount>>['screen'];
/** The row's menu owner (DropdownMenu): choose an item the way a press on it does. */
function chooseMenuItem(screen: Screen, key: string, itemId: string) {
    const menu = screen.root.findAll(node => node.props.testID === `machine-processes-menu-${key}` && typeof node.props.onSelect === 'function')[0];
    if (!menu) throw new Error(`No menu for ${key}`);
    menu.props.onSelect(itemId);
    return menu;
}
const labelledRows = (screen: Screen) => [...new Set(screen.root.findAll(node => typeof node.props.testID === 'string'
    && typeof node.type === 'string' && /^machine-processes-label-[^:]+:[^:]+$/u.test(node.props.testID)).map(node => node.props.testID as string))];

beforeEach(async () => {
  await home.reset();
  machineProcessesStore.reset();
  transport.rpc.mockReset();
});
afterEach(async () => {
  standardCleanup();
  machineProcessesStore.reset();
  await home.reset();
});

describe('MachineProcessesTab', () => {
  it('renders the browser engine and redacted driver in its existing row', async () => {
    const answer = createProcessesAnswer();
    const owner = answer.owners[0];
    owner.members.push(processRow('browser-main', 'runner', { role: 'browser', browserEngine: 'chromium', browserHelper: false,
      command: 'chromium --headless', driverLabel: 'node playwright test', memoryBytes: 10,
      browserGroup: { memberRefs: ['browser-main'], totals: { memoryBytes: 10, processCount: 1 } } }));
    const { screen } = await mount({ answer });
    await act(async () => { screen.pressByTestId(`machine-processes-row-o:${owner.rowId}`); });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-row-p:browser-main')).not.toBeNull()); });
    expect(textOf(screen.findByTestId('machine-processes-row-p:browser-main'))).toContain('Chromium');
    expect(textOf(screen.findByTestId('machine-processes-row-p:browser-main'))).toContain('node playwright test');
  });
  it.each([
    { id: 'processes' as const },
    { id: 'processes' as const, page: 'owner' as const, owner: 'session:refactor' },
  ])('shows offline without a loading surface when no process answer exists ($page)', async (params) => {
    const { screen } = await mount({ online: false, waitForRows: false, params });
    expect(screen.findByTestId('machine-processes-offline-empty')).not.toBeNull();
    expect(screen.findByTestId('machine-processes-table')).toBeNull();
    expect(transport.rpc.mock.calls.some(([rpc]: readonly unknown[]) => typeof rpc === 'object' && rpc !== null && 'method' in rpc
      && (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST || rpc.method === RPC_METHODS.DAEMON_PROCESSES_WATCH))).toBe(false);
  });

  it('explains the unavailable predecessor process operation instead of a failed request', async () => {
    const { screen } = await mount({ waitForRows: false, reply: (rpc) => {
      if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    } });
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-processes-older')).not.toBeNull()); });
    expect(screen.findByTestId('machine-processes-error')).toBeNull();
  });

  it('lists each owner with its own totals, opens one in place, and closes on Happier in total', async () => {
    const { screen } = await mount();
    // Owners carry their totals; what they started stays folded until the owner is opened.
    expect(
      screen.findByTestId('machine-processes-row-o:service:website'),
    ).not.toBeNull();
    expect(
      textOf(
        screen.findByTestId('machine-processes-memory-o:session:refactor'),
      ),
    ).toBe('3.75 GB');
    expect(screen.findByTestId('machine-processes-row-p:tsgo')).toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-p:tsgo'),
        ).not.toBeNull(),
      );
    });
    // The runner is the owner row itself, never a child of it.
    expect(screen.findByTestId('machine-processes-row-p:runner')).toBeNull();
    expect(screen.getTextContent()).toContain('Happier in total');
    expect(
      textOf(screen.findByTestId('machine-processes-total-happier-memory')),
    ).toBe('5.13 GB');
  });

  it('says once, in its freshness chip, that the machine stopped answering, and keeps the rows', async () => {
    let lists = 0;
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) lists += 1;
        // The machine answers the first read, then stops answering.
        if (rpc.method === RPC_METHODS.DAEMON_PROCESSES_WATCH) return Promise.reject(new Error('timeout'));
        return undefined;
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId('machine-processes-stale')).not.toBeNull());
    });
    // One cause, one place: the chip says when and offers Retry; no second strip, no "Live", rows at full strength.
    expect(textOf(screen.findByTestId('machine-processes-stale'))).toContain('Retry');
    expect(screen.findByTestId('machine-processes-live')).toBeNull();
    expect(screen.getTextContent()).not.toContain('Live');
    expect(screen.findByTestId('machine-processes-row-o:session:refactor')).not.toBeNull();
    const before = lists;
    await act(async () => {
      screen.pressByTestId('machine-vitals-retry');
    });
    await act(async () => {
      await vi.waitFor(() => expect(lists).toBeGreaterThan(before));
    });
  });

  it('labels only what it cannot prove', async () => {
    const { screen } = await mount();
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-p:vite'),
        ).not.toBeNull(),
      );
    });
    expect(labelledRows(screen)).toEqual(['machine-processes-label-p:vite']);
    const text = screen.getTextContent();
    expect(text).toContain('Likely');
    expect(text).not.toContain('Proven');
  });

  it('recounts Left behind to the rows a search leaves, and its cleanup echoes exactly those', async () => {
    const cleanups: unknown[] = [];
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_LEFT_BEHIND_CLEAN_UP)
          return undefined;
        cleanups.push(rpc.payload);
        return {
          ended: [{ ref: 'left-postgres', freedBytes: 150 * 1024 * 1024 }],
          skipped: [],
        };
      },
    });
    expect(screen.getTextContent()).toContain('Clean up 3 · 1.37 GB');
    await act(async () => {
      screen.changeTextByTestId('machine-processes-search', 'postgres');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.getTextContent()).toContain('Clean up 1 · 150 MB'),
      );
    });
    expect(screen.findByTestId('machine-processes-row-l:left-next')).toBeNull();
    expect(
      screen.findByTestId('machine-processes-row-l:left-postgres'),
    ).not.toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-tile-left-behind');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-processes-review')).not.toBeNull(),
      );
    });
    expect(
      textOf(screen.findByTestId('machine-processes-review-summary')),
    ).toContain('1 of 1 selected');
    await act(async () => {
      screen.pressByTestId('machine-processes-review-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(cleanups).toHaveLength(1));
    });
    expect(cleanups[0]).toMatchObject({
      machineId: 'machine',
      refs: ['left-postgres'],
    });
  });

  it('checks a process it cannot prove again before it can be killed, and says what it found', async () => {
    const kills: unknown[] = [];
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_GET) {
                return { row: { ...createProcessesAnswer().owners[0]!.members.find(row => row.ref === 'vite')!, evidence: [
                    { kind: 'fence', state: 'not_available', reason: 'macos_no_fence' },
                    { kind: 'group_and_port', state: 'met', reason: 'same_group_port_opened_while_running' }] }, owner: { kind: 'session', sessionId: 'refactor' } };
            }
            if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_CHECK)
          return {
            checks: [
              {
                ref: 'vite',
                present: true,
                identityEqual: true,
                level: 'likely',
              },
            ],
          };
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_KILL) {
          kills.push(rpc.payload);
          return {
            status: 'ended',
            outcomes: [{ ref: 'vite', outcome: 'ended', freedBytes: 1 }],
          };
        }
        return undefined;
      },
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-row-o:session:refactor');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-menu-p:vite'),
        ).not.toBeNull(),
      );
    });
    await act(async () => {
      chooseMenuItem(screen, 'p:vite', 'kill');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          textOf(screen.findByTestId('machine-processes-kill-ask-first-note')),
        ).toContain('Checked again just now: same process, started'),
      );
    });
    expect(screen.getTextContent()).toContain(
      'Same group as the session, and its port opened while it ran',
    );
    await act(async () => {
      screen.pressByTestId('machine-processes-kill-ask-first-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(kills).toHaveLength(1));
    });
    expect(kills[0]).toMatchObject({
      tree: false,
      targets: [
        {
          ref: 'vite',
          expect: {
            level: 'likely',
            owner: { kind: 'session', sessionId: 'refactor' },
          },
        },
      ],
    });
  });

  it('opens filtered to Left behind from a link (filter=leftBehind), and Show all returns the whole list', async () => {
    const { parseMachineProcessesParams } = await import('./MachineProcessesTab');
    expect(parseMachineProcessesParams({ filter: 'leftBehind', sort: 'cpu' })).toEqual({ id: 'processes', sort: 'cpu', filter: 'leftBehind' });
    expect(parseMachineProcessesParams({ filter: 'other' })).toEqual({ id: 'processes' });
    const { screen, setParams } = await mount({ params: { id: 'processes', filter: 'leftBehind' } });
    const leftRows = screen.root.findAll((node) => typeof node.type === 'string' && String(node.props.testID ?? '').startsWith('machine-processes-row-l:'));
    expect(leftRows.length).toBeGreaterThan(0);
    expect(screen.findByTestId('machine-processes-row-o:service:website')).toBeNull();
    await act(async () => {
      screen.pressByTestId('machine-processes-show-everything');
    });
    expect(setParams).toHaveBeenCalledWith({ id: 'processes' });
  });

  it('asks before stopping a guest’s session and names them, and stops your own work without asking (R42.4)', async () => {
    const base = createProcessesAnswer();
    const answer = { ...base, owners: base.owners.map((owner) => owner.rowId === 'session:refactor'
      ? { ...owner, requester: { accountId: 'guest', displayName: 'Ben' } } : owner) };
    const stops: unknown[] = [];
    const { screen } = await mount({
      answer,
      reply: (rpc) => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP) return undefined;
        stops.push(rpc.payload);
        return { status: 'ended', outcomes: [{ ref: 'runner', outcome: 'ended', freedBytes: 1 }] };
      },
    });
    await act(async () => {
      chooseMenuItem(screen, 'o:session:refactor', 'stop');
    });
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId('machine-processes-stop-guest-confirm')).not.toBeNull());
    });
    expect(screen.getTextContent()).toContain('This is Ben’s work on this machine.');
    expect(stops).toHaveLength(0);
    await act(async () => {
      screen.pressByTestId('machine-processes-stop-guest-confirm');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(1)); });

    await act(async () => {
      chooseMenuItem(screen, 'o:service:website', 'stop');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(2)); });
    expect(screen.findByTestId('machine-processes-stop-guest-confirm')).toBeNull();
  });

  it('stopping a service lets its row go and says what was freed, with the way back', async () => {
    const stops: unknown[] = [];
    const { screen } = await mount({
      reply: (rpc) => {
        if (rpc.method !== RPC_METHODS.MACHINES_PROCESSES_STOP)
          return undefined;
        stops.push(rpc.payload);
        return {
          status: 'ended',
          outcomes: [
            { ref: 'website', outcome: 'ended', freedBytes: 1.2 * GB },
          ],
        };
      },
    });
    await act(async () => {
      chooseMenuItem(screen, 'o:service:website', 'stop');
    });
    await act(async () => { await vi.waitFor(() => expect(stops).toHaveLength(1)); });
    // The row fades (160 ms) and its height closes (240 ms); then it is gone.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, PROCESS_ROW_EXIT_MS + 100)); });
    expect(screen.findByTestId('machine-processes-row-o:service:website')).toBeNull();
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          textOf(screen.findByTestId('machine-processes-freed')),
        ).toContain('1.2 GB freed'),
      );
    });
    expect(screen.findByTestId('machine-processes-start-again')).not.toBeNull();
    expect(stops[0]).toMatchObject({
      targets: [
        {
          ref: 'website',
          expect: {
            level: 'proven',
            owner: { kind: 'service', serviceId: 'website' },
          },
        },
      ],
    });
  });

  it('never shows another app’s command line, only its name, in All processes', async () => {
    const answer = createProcessesAnswer({
      notHappier: [
        {
          appGroup: 'Docker Desktop',
          members: [
            {
              name: 'com.docker.backend',
              appGroup: 'Docker Desktop',
              pid: 900,
              ref: 'docker-backend',
              memoryBytes: 640,
              cpuPercent: 0.1,
            },
          ],
        },
      ],
    });
    const { screen } = await mount({
      answer,
      machine: {
        metadata: {
          host: 'leeroy-mbp',
          platform: 'darwin',
          happyCliVersion: '0.3.0',
          happyHomeDir: '/Users/leeroy/.happier',
          homeDir: '/Users/leeroy',
          resourcesPolicyV1: { v: 1, processes: { allProcessesVisible: true } },
        } as Machine['metadata'],
      },
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-scope:all');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-a:Docker Desktop'),
        ).not.toBeNull(),
      );
    });
    await act(async () => {
      screen.pressByTestId('machine-processes-row-a:Docker Desktop');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.findByTestId('machine-processes-row-m:docker-backend'),
        ).not.toBeNull(),
      );
    });
    const row = textOf(
      screen.findByTestId('machine-processes-row-m:docker-backend'),
    );
    expect(row).toContain('com.docker.backend');
    // Its menu offers the name only: the command never left the machine.
    expect(screen.root.findAll(node => node.props.testID === 'machine-processes-menu-m:docker-backend' && Array.isArray(node.props.items))[0]!.props.items.map((item: { title: string }) => item.title)).toEqual(['Copy name', 'Kill process…']);
  });
});

/**
 * A terminal whose own shell listens on :8080 and which started a dev server on :4000, as the
 * daemon reports it, plus the Local services feeds that list both listeners as detected services.
 */
function terminalPortsAnswer(): MachineProcessesAnswerV1 {
  const base = createProcessesAnswer();
  const shell = processRow('term-shell', 'terminal:dev', {
    name: 'zsh',
    role: 'tool_shell',
    command: 'zsh -l',
    memoryBytes: 40 * MB,
    startedAtMs: 100,
    ports: [{ port: 8080, inventoryEntryId: 'entry-8080' }],
  });
  const server = processRow('term-server', 'term-shell', {
    name: 'node',
    role: 'dev_server',
    command: 'node server.js',
    memoryBytes: 200 * MB,
    ports: [{ port: 4000, inventoryEntryId: 'entry-4000' }],
  });
  return {
    ...base,
    owners: [
      ...base.owners,
      {
        rowId: 'terminal:dev',
        owner: { kind: 'terminal', terminalId: 'dev' },
        state: 'running',
        totals: { memoryBytes: 240 * MB, cpuPercent: 0, processCount: 2 },
        members: [shell, server],
      },
    ],
  };
}

/** The preview the private-preview access owner registered for a listener (session-bound, as the daemon issues it). */
const previewResource = (port: number) => ({
  previewId: `preview-${port}`,
  sessionId: 'session-1',
  machineId: 'machine',
  owner: { kind: 'session' as const, id: 'session-1' },
  target: { scheme: 'http' as const, host: '127.0.0.1', port },
  initialPath: { pathname: '/', search: '' },
  display: { title: `localhost:${port}`, addressLabel: `localhost:${port}` },
  originMode: 'host' as const,
});
// :8080 already has a preview that this device has no private route to; :4000 has none yet.
const unreachablePreview = {
  previewId: 'preview-8080',
  resource: previewResource(8080),
  accessUrl: null,
  expiresAt: null,
  accessUnavailableReasonCode: 'preview_private_route_unavailable' as const,
  diagnostics: [],
};
const ACCESS_URL_4000 = 'https://preview-4000.preview.test/?previewToken=fresh';

const detected = (port: number) => ({
  id: `detected:${port}`,
  source: 'inventory_entry' as const,
  sourceClass: { kind: 'inventory_entry' as const, inventoryEntryId: `entry-${port}` },
  machineId: 'machine',
  title: `localhost:${port}`,
  subtitle: `localhost:${port}`,
  confidence: 'high' as const,
  state: 'available' as const,
  ...(port === 8080
    ? {
        actions: ['open_preview' as const, 'register_preview' as const, 'terminate_detected' as const],
        browserTarget: { kind: 'localServicePreview' as const, targetId: 'preview-8080', machineId: 'machine', sessionId: 'session-1' },
      }
    : { actions: ['register_preview' as const, 'terminate_detected' as const] }),
});

/** Local services' daemon boundary: the inventory and launcher reads, and the Actions it executes. */
function localServicesReply(executed: Record<string, unknown>[]) {
  return (rpc: Rpc): unknown => {
    if (
      rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT ||
      rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH
    )
      return {
        protocolVersion: 1,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 2_000,
          refreshState: 'idle',
          entries: [8080, 4000].map((port) =>
            buildLocalServiceInventoryRow({ id: `entry-${port}`, machineId: 'machine', port }),
          ),
          diagnostics: [],
        },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT)
      return {
        protocolVersion: 1,
        snapshot: { v: 1, machineId: 'machine', updatedAt: 2_000, targets: [detected(8080), detected(4000)] },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT)
      return {
        protocolVersion: 1,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 2_000,
          refreshState: 'idle',
          resources: [previewResource(8080)],
          previews: [unreachablePreview],
          diagnostics: [],
        },
      };
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE) {
      const preview = { previewId: 'preview-4000', resource: previewResource(4000), accessUrl: ACCESS_URL_4000, expiresAt: 61_000, diagnostics: [] };
      return {
        protocolVersion: 1,
        status: 'created',
        preview,
        snapshot: {
          v: 1,
          machineId: 'machine',
          generatedAt: 3_000,
          refreshState: 'idle',
          resources: [previewResource(8080), previewResource(4000)],
          previews: [unreachablePreview, preview],
          diagnostics: [],
        },
      };
    }
    if (rpc.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_EXECUTE) {
      const request = rpc.payload as Record<string, unknown>;
      executed.push(request);
      return {
        protocolVersion: 1,
        result: { v: 1, requestId: request.requestId, action: request.action, status: 'succeeded', auditEvents: [] },
      };
    }
    return undefined;
  };
}

type PortMenuItem = Readonly<{ id: string; title: string; subtitle?: string; disabled?: boolean }>;
const portMenu = (screen: Screen, key: string, port: number) =>
  screen.root.findAll(
    (node) =>
      node.props.testID === `machine-processes-port-menu-${key}-${port}` &&
      typeof node.props.onSelect === 'function',
  )[0];

/** Press the chip, then wait until its menu offers what Local services offers for that listener. */
async function openPortMenu(screen: Screen, key: string, port: number, expected = 'stop') {
  await act(async () => {
    screen.pressByTestId(`machine-processes-port-${key}-${port}`);
  });
  // The menu opens on the frame after the press.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        (portMenu(screen, key, port)?.props.items as PortMenuItem[] | undefined)?.map((item) => item.id),
      ).toContain(expected),
    );
  });
  return portMenu(screen, key, port)!;
}

async function openTerminal(screen: Screen) {
  await act(async () => {
    screen.pressByTestId('machine-processes-row-o:terminal:dev');
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(screen.findByTestId('machine-processes-row-p:term-server')).not.toBeNull(),
    );
  });
}

describe('MachineProcessesTab port chips', () => {
  it('opens what Local services offers for the listener and copies its address through that Action', async () => {
    const executed: Record<string, unknown>[] = [];
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply(executed) });
    await openTerminal(screen);
    // Copy address appears once the inventory names where the listener answers.
    const menu = await openPortMenu(screen, 'p:term-server', 4000, 'copy');
    const items = menu.props.items as PortMenuItem[];
    expect(items.map((item) => item.title)).toEqual(['Open in browser', 'Copy address', 'Stop server on :4000']);
    expect(items[0]!.disabled).toBe(false);
    expect(items[1]!.subtitle).toBe('127.0.0.1:4000');
    expect(items[2]!.subtitle).toBe('Frees about 200 MB');
    await act(async () => {
      menu.props.onSelect('copy');
    });
    await act(async () => {
      await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
    expect(executed[0]).toMatchObject({
      action: 'copy_url',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-4000', machineId: 'machine' },
    });
    // Open in browser registers through the Services opener and opens the URL its access owner admits.
    const { Linking } = await import('react-native');
    const openURL = vi.spyOn(Linking, 'openURL');
    const reopened = await openPortMenu(screen, 'p:term-server', 4000, 'open-browser');
    await act(async () => {
      reopened.props.onSelect('open-browser');
    });
    await act(async () => {
      await vi.waitFor(() => expect(openURL).toHaveBeenCalledWith(ACCESS_URL_4000));
    });
    openURL.mockRestore();
  });

  it('keeps Open in browser for a listener this device has no route to, and says why', async () => {
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply([]) });
    const menu = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          (portMenu(screen, 'o:terminal:dev', 8080)!.props.items as PortMenuItem[]).find((item) => item.id === 'open-browser'),
        ).toMatchObject({
          title: 'Open in browser',
          disabled: true,
          subtitle: 'This device can’t open it directly. Share a link from Local services to open it here.',
        }),
      );
    });
    expect(menu).toBeDefined();
  });

  it('says freeing the shell’s own port closes the terminal, and frees a child’s port without it', async () => {
    const executed: Record<string, unknown>[] = [];
    const { screen } = await mount({ answer: terminalPortsAnswer(), reply: localServicesReply(executed) });
    await openTerminal(screen);
    // The terminal's own shell is its owner row; its port is the shell's listener.
    const shellMenu = await openPortMenu(screen, 'o:terminal:dev', 8080);
    await act(async () => {
      shellMenu.props.onSelect('stop');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('machine-processes-port-close-terminal')).not.toBeNull(),
      );
    });
    expect(textOf(screen.findByTestId('machine-processes-port-close-terminal'))).toContain(
      'This closes the terminal Terminal · zsh.',
    );
    expect(executed).toHaveLength(0);
    await act(async () => {
      screen.pressByTestId('machine-processes-port-close-terminal-confirm');
    });
    await act(async () => {
      await vi.waitFor(() => expect(executed).toHaveLength(1));
    });
    expect(executed[0]).toMatchObject({
      action: 'terminate_detected',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-8080' },
    });

    // A dev server the shell started is a child: stopping it leaves the terminal open, so no warning.
    const childMenu = await openPortMenu(screen, 'p:term-server', 4000);
    await act(async () => {
      childMenu.props.onSelect('stop');
    });
    await act(async () => {
      await vi.waitFor(() => expect(executed).toHaveLength(2));
    });
    expect(screen.findByTestId('machine-processes-port-close-terminal')).toBeNull();
    expect(executed[1]).toMatchObject({
      action: 'terminate_detected',
      target: { kind: 'inventory_entry', inventoryEntryId: 'entry-4000' },
    });
  });
});
