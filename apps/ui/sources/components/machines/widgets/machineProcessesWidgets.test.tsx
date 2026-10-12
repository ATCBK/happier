import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type { MachineProcessesAnswerV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import { renderScreen } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';

import {
  createProcessesAnswer,
  PROCESSES_FIXTURE_BYTES,
} from '@/components/machines/processes/testkit/processesAnswerFixture';

installDisconnectedServerSocketBoundary();
const transport = vi.hoisted(() => ({ rpc: vi.fn() }));
// Only the machine network and navigation are replaced; credential binding, the process store, Actions,
// approval policy, the Processes tab's controller and the widget bodies run for real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.rpc);
  },
);
const routerMock = vi.hoisted(() => ({
  spies: null as unknown as { push: ReturnType<typeof vi.fn> },
}));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const mock = createExpoRouterMock();
  routerMock.spies = mock.spies;
  return mock.module;
});
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
const { readPresentationNotice, retirePresentationNotice } =
  await import('@/components/sessions/presentation/presentationNotices');
const { measureMountedCollections } =
  await import('@/dev/testkit/render/renderInCollectionLayout');
const { MachineTopConsumersWidget } =
  await import('./MachineTopConsumersWidget');
const { MachineLeftBehindWidget } = await import('./MachineLeftBehindWidget');

const { GB } = PROCESSES_FIXTURE_BYTES;
type Rpc = Readonly<{ method: string; payload?: Record<string, unknown> }>;

function machine(overrides: Partial<Machine> = {}): Machine {
  return createMachineFixture({
    id: 'machine',
    active: true,
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
    ...overrides,
  });
}

const FOOTPRINTS = {
  small: {
    columns: 2,
    columnSpan: 1,
    rowSpan: 1,
    width: 'half',
    height: 'compact',
  },
  medium: {
    columns: 2,
    columnSpan: 1,
    rowSpan: 2,
    width: 'half',
    height: 'regular',
  },
  wide: {
    columns: 2,
    columnSpan: 2,
    rowSpan: 1,
    width: 'full',
    height: 'compact',
  },
} as const;

async function mount(
  options: Readonly<{
    Body: typeof MachineTopConsumersWidget;
    size?: keyof typeof FOOTPRINTS;
    answer?: MachineProcessesAnswerV1;
    reply?: (rpc: Rpc) => unknown;
    machine?: Partial<Machine>;
    waitFor?: string;
  }>,
) {
  const serverId = await home.addHome({
    name: 'Widgets Home',
    serverUrl: `https://process-widgets-${Math.random().toString(36).slice(2)}.test`,
    accountId: 'owner',
  });
  // The person's own approval setting for Stop on this device (R41); nothing in the widget decides it.
  home.answer(serverId, '/v2/account/settings', {
    body: {
      content: {
        t: 'plain',
        v: {
          actionsSettingsV1: {
            v: 1,
            actions: {},
            approvalWaivedSurfaces: { 'machines.processes.stop': ['ui'] },
          },
        },
      },
      version: 1,
    },
  });
  storage.setState({
    machines: {},
    machineListByServerId: { [serverId]: [machine(options.machine)] },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
  const answer = options.answer ?? createProcessesAnswer();
  transport.rpc.mockImplementation(async (rpc: Rpc) => {
    const reply = options.reply?.(rpc);
    if (reply !== undefined) return reply;
    if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_LIST) return answer;
    return new Promise(() => {});
  });
  const size: WidgetSizeV1 = options.size ?? 'medium';
  const Body = options.Body;
  const screen = await renderScreen(
    <AuthProvider
      initialCredentials={{
        token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
      }}
    >
      <ModalProvider>
        <WidgetPresentationProvider
          value={{
            size,
            footprint: FOOTPRINTS[options.size ?? 'medium'],
            geometry: { width: 354, height: 348 },
          }}
        >
          <Body
            input={{ machine: { serverId, machineId: 'machine' } }}
            serverId={serverId}
            testID="widget"
          />
        </WidgetPresentationProvider>
      </ModalProvider>
    </AuthProvider>,
  );
  if (options.waitFor) {
    const id = options.waitFor;
    await act(async () => {
      await vi.waitFor(() => expect(screen.findByTestId(id)).not.toBeNull());
    });
    await measureMountedCollections(screen, { width: 354 });
  }
  return { screen, serverId };
}

beforeEach(async () => {
  await home.reset();
  machineProcessesStore.reset();
  transport.rpc.mockReset();
  retirePresentationNotice();
});
afterEach(async () => {
  standardCleanup();
  machineProcessesStore.reset();
  await home.reset();
});

describe('Using the most widget', () => {
  it('stops a service through machines.processes.stop and offers its way back on the row and in the notice', async () => {
    const calls: Rpc[] = [];
    const { screen } = await mount({
      Body: MachineTopConsumersWidget,
      waitFor: 'widget.stop-o:service:website',
      reply: (rpc) => {
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_STOP) {
          calls.push(rpc);
          return {
            status: 'ended',
            outcomes: [
              { ref: 'website', outcome: 'ended', freedBytes: 1.2 * GB },
            ],
          };
        }
        if (rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN) {
          calls.push(rpc);
          return { status: 'started' };
        }
        return undefined;
      },
    });
    // Happier's own daemon is never a Stop target.
    expect(screen.findByTestId('widget.stop-o:happier')).toBeNull();
    await act(async () => {
      await screen.pressByTestIdAsync('widget.stop-o:service:website');
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(screen.findByTestId('widget.stopped')).not.toBeNull(),
      );
    });
    expect(calls[0]).toMatchObject({
      method: RPC_METHODS.MACHINES_PROCESSES_STOP,
      payload: {
        targets: [
          {
            ref: 'website',
            expect: {
              level: 'proven',
              owner: { kind: 'service', serviceId: 'website' },
            },
          },
        ],
      },
    });
    expect(screen.getTextContent()).toContain('1.2 GB freed');
    const notice = readPresentationNotice();
    expect(notice?.undo?.label).toBe('Undo');

    await act(async () => {
      notice!.undo!.run();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          calls.some(
            (rpc) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN,
          ),
        ).toBe(true),
      );
    });
    expect(
      calls.find(
        (rpc) => rpc.method === RPC_METHODS.MACHINES_PROCESSES_START_AGAIN,
      )?.payload,
    ).toMatchObject({ ref: 'website' });
  });

  it('says so quietly when nothing of Happier’s is running, and reads nothing on an offline machine', async () => {
    const { screen } = await mount({
      Body: MachineTopConsumersWidget,
      answer: createProcessesAnswer({ owners: [] }),
      waitFor: 'widget.empty',
    });
    expect(screen.getTextContent()).toContain(
      'Nothing of Happier’s is running',
    );

    transport.rpc.mockClear();
    const offline = await mount({
      Body: MachineTopConsumersWidget,
      machine: { active: false, activeAt: 1_000 },
      waitFor: 'widget.offline',
    });
    expect(offline.screen.getTextContent()).toContain('Last seen');
    expect(
      transport.rpc.mock.calls.some(
        ([rpc]) => (rpc as Rpc).method === RPC_METHODS.MACHINES_PROCESSES_LIST,
      ),
    ).toBe(false);
  });
});

describe('Left behind widget', () => {
  it('counts the set the cleanup would act on, and Clean up opens Processes without stopping anything', async () => {
    const { screen, serverId } = await mount({
      Body: MachineLeftBehindWidget,
      size: 'small',
      waitFor: 'widget.cleanUp',
    });
    expect(screen.getTextContent()).toContain('3');
    expect(screen.getTextContent()).toContain('Holding 1.37 GB of memory');
    await act(async () => {
      await screen.pressByTestIdAsync('widget.cleanUp');
    });
    expect(routerMock.spies.push).toHaveBeenCalledWith(
      expect.stringContaining(
        `/machine?serverId=${encodeURIComponent(serverId)}&tab=processes`,
      ),
    );
    // It opens the Processes tab on what ended sessions left running (plan 30's `filter=leftBehind`).
    expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringContaining('filter=leftBehind'));
    expect(
      transport.rpc.mock.calls.some(([rpc]) =>
        String((rpc as Rpc).method).startsWith('machines.processes.leftBehind'),
      ),
    ).toBe(false);
  });

  it('is one quiet line when nothing is left behind', async () => {
    const { screen } = await mount({
      Body: MachineLeftBehindWidget,
      answer: createProcessesAnswer({ leftBehind: [] }),
      waitFor: 'widget.empty',
    });
    expect(screen.getTextContent()).toContain('Nothing left behind');
  });
});
