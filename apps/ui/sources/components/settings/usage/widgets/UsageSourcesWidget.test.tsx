import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { USAGE_SOURCE_CONSENT_DISCLOSURE } from '@happier-dev/protocol/usage/usageSources';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import {
  type UsageSourceV1,
} from '@happier-dev/protocol/usage/usageSources';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';
import { UsageSourcesMachines, projectUsageSourcesMachines } from './UsageSourcesWidget';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
it('retains source inventory but withdraws execution from machines with locked content', () => {
  const machines = [
    createMachineFixture({ id: 'locked', activeAt: Date.now(), availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }),
    createMachineFixture({ id: 'ready', activeAt: Date.now() }),
  ];
  expect(projectUsageSourcesMachines(machines, Date.now(), { serverId: 'home', accountId: 'account' }).map(machine => [machine.id, machine.online]))
    .toEqual([['ready', true], ['locked', false]]);
});

const confirm = vi.fn<(title: string, message?: string) => Promise<boolean>>();
const prompt = vi.fn<() => Promise<string | null>>();
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string, params?: Record<string, unknown>) => key === 'machines.widgets.body.fleet.offlineGroup' ? `${params?.count} offline`
      : key === 'projects.identity.machineCount' ? `${params?.count} machines` : key,
  }),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      spies: {
        confirm: (title: string, message?: string) => confirm(title, message),
        prompt: () => prompt(),
      },
    }).module,
);

const found: UsageSourceV1 = {
  serverId: 'home',
  machineId: 'mac',
  sourceId: 'claude-default',
  accountingSources: ['claude-assistant-usage', 'claude-sdk-result'],
  captureKind: 'from_logs',
  agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
  root: { kind: 'default', path: '/Users/ada/.claude' },
  consent: 'disabled',
  status: 'found',
  coverage: 'unknown',
  pendingCount: 0,
  asOfMs: null,
};
const lifetime: ServerAccountScopeLifetime = {
  scope: { serverId: 'home', accountId: 'account' },
  isCurrent: () => true,
  onRetire: () => ({ dispose: () => {} }),
};

/** The Machine RPC is the genuine boundary; Action admission, parsing and the controller stay real. */
function machineBoundary(initial: UsageSourceV1 = found, initialDiscovery?: readonly UsageSourceV1[]) {
  const calls: string[] = [];
  let current = initial;
  let discovery = initialDiscovery;
  let discoveryFails = false;
  const settings = ActionsSettingsV1Schema.parse({
    v: 1,
    approvalWaivedSurfaces: {
      'usage.sources.consent.set': ['ui'],
      'usage.sources.stop': ['ui'],
      'usage.sources.history.delete': ['ui'],
      'usage.sources.root.set': ['ui'],
    },
  });
  const executor = createActionExecutor({
    usageSourceAction: createUsageSourceActionPort({
      serverId: 'home',
      assertCurrent: () => {},
      rpc: async (request) => {
        calls.push(request.actionId);
        if (request.actionId === 'usage.sources.discover' && discoveryFails) throw new Error('machine unavailable');
        if (request.actionId === 'usage.sources.consent.set') {
          current = {
            ...current,
            consent: 'enabled',
            status: 'reading',
            pendingCount: 12,
          };
          return { source: current };
        }
        if (request.actionId === 'usage.sources.stop') {
          current = { ...current, consent: 'disabled', status: 'stopped' };
          return { source: current };
        }
        if (request.actionId === 'usage.sources.history.delete') return { success: true, deletedEventCount: 3 };
        if (request.actionId === 'usage.sources.root.set') {
          current = { ...current, root: { kind: request.input.root === null ? 'default' : 'override', path: request.input.root ?? found.root.path }, consent: 'disabled', status: 'found' };
          return { source: current };
        }
        return { sources: discovery ?? [current] };
      },
      dismiss: async () => ({ status: 'dismissed' }),
    }),
    isActionApprovalRequired: (id, context) =>
      isApprovalRequiredByActionsSettings(id, settings, context),
  } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
  return { calls, executor, setDiscovery: (sources: readonly UsageSourceV1[]) => { discovery = sources; },
    failDiscovery: (fails = true) => { discoveryFails = fails; } };
}

async function mount(executor: ReturnType<typeof machineBoundary>['executor'], input = { agents: [] as string[], machines: ['mac'], sources: [] as string[] }, otherMachine = false) {
  return renderScreen(
    <UsageSourcesMachines
      lifetime={lifetime}
      serverId="home"
      executor={executor}
      testID="sources"
      input={input}
      machines={[
        { id: 'mac', name: 'MacBook Pro', online: true, homeDir: '/Users/ada' },
        ...(otherMachine ? [{ id: 'other', name: 'Other machine', online: true }] : []),
      ]}
    />,
  );
}

afterEach(() => {
  standardCleanup();
  confirm.mockReset();
  prompt.mockReset();
});

describe('Usage Sources body', () => {
  it('summarizes resolved empty machines and restores discovered content and retry after fresh demand', async () => {
    const boundary = machineBoundary(found, []);
    const props = { lifetime, serverId: 'home', executor: boundary.executor, testID: 'sources', input: { agents: [], machines: [], sources: [] } };
    const machine = { id: 'mac', name: 'Mac', online: true };
    const screen = await renderScreen(<UsageSourcesMachines {...props} machines={[machine, { ...machine, id: 'other' }]} />);
    await vi.waitFor(() => expect(screen.findByTestId('sources.emptyMachines')).toBeTruthy());
    expect(screen.findByTestId('sources.emptyMachines')?.props.accessibilityLabel).toContain('2');
    expect(screen.findAllHostsByTestId('sources.machine.mac')).toHaveLength(0);
    expect(screen.findAllHostsByTestId('sources.machine.other')).toHaveLength(0);

    await screen.update(<UsageSourcesMachines {...props} machines={[]} />);
    boundary.setDiscovery([found]);
    await screen.update(<UsageSourcesMachines {...props} machines={[machine]} />);
    await vi.waitFor(() => expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeTruthy());
    expect(screen.findByTestId('sources.emptyMachines')).toBeFalsy();

    await screen.update(<UsageSourcesMachines {...props} machines={[]} />);
    boundary.failDiscovery();
    await screen.update(<UsageSourcesMachines {...props} machines={[machine]} />);
    // A machine that can't be read says so once, grouped with its Retry, never also "Looking for files".
    await vi.waitFor(() => expect(screen.findByTestId('sources.unreadableMachines')).toBeTruthy());
    expect(screen.getTextContent()).not.toContain(t('usage.board.sources.machineLooking'));
    expect(screen.findByTestId('sources.emptyMachines')).toBeFalsy();
    expect(screen.findAllHostsByTestId('sources.machine.mac')).toHaveLength(0);
    boundary.failDiscovery(false);
    boundary.setDiscovery([]);
    await screen.pressByTestIdAsync('sources.unreadableMachines-action');
    await vi.waitFor(() => expect(screen.findByTestId('sources.emptyMachines')).toBeTruthy());
    expect(screen.findByTestId('sources.emptyMachines')?.props.accessibilityLabel).toContain('1');
    expect(screen.findByTestId('sources.unreadableMachines')).toBeFalsy();
  });
  it('leads with what is counted: Happier sessions live, then each counted source with the time it was read', async () => {
    const counted = { ...found, consent: 'enabled', status: 'ready', coverage: 'complete', asOfMs: Date.UTC(2026, 9, 16, 12, 0) } as UsageSourceV1;
    const boundary = machineBoundary(counted);
    const screen = await mount(boundary.executor);
    expect(screen.findByTestId('sources.happier')).toBeTruthy();
    expect(screen.getTextContent()).toContain(t('usage.board.sources.happierLive'));
    await vi.waitFor(() => expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeTruthy());
    // The counted source says when it was read, not a bare "up to date".
    expect(screen.getTextContent()).toContain('countedAsOf');
  });
  it('does not count or discover a replaced machine identity as another current computer', () => {
    const machine = { id: 'old', metadata: null, active: true, activeAt: 1000, replacedByMachineId: 'current' };
    const projected = projectUsageSourcesMachines([machine, { ...machine, id: 'current', replacedByMachineId: null }], 1000, lifetime.scope);
    expect(projected.map(machine => machine.id)).toEqual(['current']);
  });
  it('uses a bounded inventory summary without starting discovery in the Overview tile projection', async () => {
    const boundary = machineBoundary();
    const screen = await renderScreen(<UsageSourcesMachines lifetime={lifetime} serverId="home" executor={boundary.executor}
      testID="sources" input={{ agents: [], machines: [], sources: [] }} compact
      machines={[{ id: 'mac', name: 'Mac', online: true }, { id: 'off', name: 'Other', online: false }]} />);
    expect(screen.findByTestId('sources.summary')).toBeTruthy();
    expect(screen.findByTestId('sources.machine.mac')).toBeFalsy();
    expect(boundary.calls).toEqual([]);
  });
  it('collapses offline identities without mounting discovery and keeps same-name online machines distinct', async () => {
    const boundary = machineBoundary();
    const screen = await renderScreen(<UsageSourcesMachines lifetime={lifetime} serverId="home" executor={boundary.executor}
      testID="sources" input={{ agents: [], machines: [], sources: [] }} machines={[
        { id: 'mac', name: 'Laptop', online: true }, { id: 'mac', name: 'Laptop', online: true },
        { id: 'other', name: 'Laptop', online: true },
        { id: 'off-a', name: 'Laptop', online: false }, { id: 'off-b', name: 'Laptop', online: false },
      ]} />);
    await vi.waitFor(() => expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeTruthy());
    expect(screen.findAllHostsByTestId('sources.machine.mac')).toHaveLength(1);
    expect(screen.findByTestId('sources.machine.other')).toBeTruthy();
    expect(screen.findByTestId('sources.machine.off-a')).toBeFalsy();
    expect(screen.findByTestId('sources.offline')).toBeTruthy();
    expect(screen.findByTestId('sources.offline')?.props.accessibilityLabel).toContain('2');
  });
  it('discovers only resolved machines and hides inventory outside the resolved Agent scope', async () => {
    const codex: UsageSourceV1 = { ...found, sourceId: 'codex-default',
      agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, accountingSources: ['codex-native-accounting'] };
    const boundary = machineBoundary(found, [found, codex]);
    const screen = await mount(boundary.executor, { agents: ['codex'], machines: ['mac'], sources: ['claude-assistant-usage'] }, true);
    await vi.waitFor(() => expect(boundary.calls).toContain('usage.sources.discover'));
    expect(Boolean(screen.findByTestId('sources.machine.other'))).toBe(false);
    expect(Boolean(screen.findByTestId('sources.machine.mac.source.claude-default'))).toBe(false);
    expect(Boolean(screen.findByTestId('sources.machine.mac.source.codex-default'))).toBe(false);
    await screen.update(<UsageSourcesMachines
      lifetime={lifetime} serverId="home" executor={boundary.executor} testID="sources"
      input={{ agents: ['claude'], machines: ['mac'], sources: ['claude-assistant-usage'] }}
      machines={[{ id: 'mac', name: 'MacBook Pro', online: true }]} />);
    await vi.waitFor(() => expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeTruthy());
    await screen.update(<UsageSourcesMachines lifetime={lifetime} serverId="home" executor={boundary.executor}
      testID="sources" input={{ agents: [], machines: ['mac'], sources: ['codex-native-accounting'] }}
      machines={[{ id: 'mac', name: 'MacBook Pro', online: true }]} />);
    expect(screen.findByTestId('sources.machine.mac.source.codex-default')).toBeTruthy();
    expect(screen.findByTestId('sources.machine.mac.source.claude-default')).toBeNull();
  });

  it('excludes runtime-only accounting and capture-path aliases without browsing source records', async () => {
    const boundary = machineBoundary();
    const screen = await mount(boundary.executor, { agents: [], machines: ['mac'], sources: ['runtime'] });
    await vi.waitFor(() => expect(screen.findByTestId('sources.emptyMachines')).toBeTruthy());
    expect(Boolean(screen.findByTestId('sources.machine.mac.source.claude-default'))).toBe(false);
    expect(boundary.calls).toEqual(['usage.sources.discover']);
    await screen.update(<UsageSourcesMachines lifetime={lifetime} serverId="home" executor={boundary.executor}
      testID="sources" machines={[{ id: 'mac', name: 'Mac', online: true }]}
      input={{ agents: [], machines: ['mac'], sources: ['native'] }} />);
    expect(Boolean(screen.findByTestId('sources.machine.mac.source.claude-default'))).toBe(false);
  });

  it('uses the qualified Agent identity without treating another plugin local id as a bundled Agent', async () => {
    const external = { ...found, agent: { pluginId: 'third.party', localId: 'claude' } };
    const boundary = machineBoundary(external);
    const screen = await mount(boundary.executor, { agents: ['claude'], machines: ['mac'], sources: [] });
    await vi.waitFor(() => expect(boundary.calls).toContain('usage.sources.discover'));
    expect(Boolean(screen.findByTestId('sources.machine.mac.source.claude-default'))).toBe(false);
    await screen.update(<UsageSourcesMachines lifetime={lifetime} serverId="home" executor={boundary.executor}
      testID="sources" machines={[{ id: 'mac', name: 'MacBook Pro', online: true }]}
      input={{ agents: [buildQualifiedPluginContributionKey(external.agent)], machines: ['mac'], sources: [] }} />);
    await vi.waitFor(() => expect(Boolean(screen.findByTestId('sources.machine.mac.source.claude-default'))).toBe(true));
  });
  it('keeps Stop and separately confirmed Delete available for unsupported retained capture', async () => {
    const boundary = machineBoundary({ ...found, consent: 'enabled', status: 'unsupported', pendingCount: 4, errorCode: 'native_ingest_unsupported' });
    const screen = await mount(boundary.executor);
    const card = 'sources.machine.mac.source.claude-default';
    await vi.waitFor(() => expect(screen.findByTestId(`${card}.stop`)).toBeTruthy());
    expect(screen.findByTestId(`${card}.delete`)).toBeTruthy();
    await screen.pressByTestIdAsync(`${card}.stop`);
    expect(boundary.calls).toContain('usage.sources.stop');
    expect(boundary.calls).not.toContain('usage.sources.history.delete');
    confirm.mockResolvedValueOnce(true);
    await screen.pressByTestIdAsync(`${card}.delete`);
    expect(boundary.calls).toContain('usage.sources.history.delete');
  });

  it('shows the server disclosure only where a source can be enabled, not under a source that cannot be read', async () => {
    const boundary = machineBoundary({ ...found, consent: 'disabled', status: 'unsupported' });
    const screen = await mount(boundary.executor);
    const card = 'sources.machine.mac.source.claude-default';
    await vi.waitFor(() => expect(screen.findByTestId(card)).toBeTruthy());
    expect(screen.getTextContent()).not.toContain(USAGE_SOURCE_CONSENT_DISCLOSURE);
    const readable = await mount(machineBoundary().executor);
    await vi.waitFor(() => expect(readable.findByTestId(`${card}.add`)).toBeTruthy());
    expect(readable.getTextContent()).toContain(USAGE_SOURCE_CONSENT_DISCLOSURE);
  });

  it('edits and removes a discovered root before fresh disclosure consent, including after Stop', async () => {
    const boundary = machineBoundary({ ...found, root: { kind: 'override', path: '/configured' } });
    const screen = await mount(boundary.executor);
    const card = 'sources.machine.mac.source.claude-default';
    await vi.waitFor(() => expect(screen.findByTestId(`${card}.folder`)).toBeTruthy());
    expect(screen.findByTestId(`${card}.defaultFolder`)).toBeTruthy();
    prompt.mockResolvedValueOnce('/new/root');
    await screen.pressByTestIdAsync(`${card}.folder`);
    expect(boundary.calls).not.toContain('usage.sources.consent.set');
    await screen.pressByTestIdAsync(`${card}.defaultFolder`);
    expect(boundary.calls).not.toContain('usage.sources.consent.set');
    confirm.mockResolvedValueOnce(true);
    await screen.pressByTestIdAsync(`${card}.add`);
    await screen.pressByTestIdAsync(`${card}.stop`);
    prompt.mockResolvedValueOnce('/stopped/root');
    await screen.pressByTestIdAsync(`${card}.folder`);
    expect(screen.findByTestId(`${card}.add`)).toBeTruthy();
  });
  it('leaves waived source consent to the canonical Action policy without a caller confirmation', async () => {
    const boundary = machineBoundary();
    const screen = await mount(boundary.executor);
    const card = 'sources.machine.mac.source.claude-default';
    await vi.waitFor(() =>
      expect(screen.findByTestId(`${card}.add`)).toBeTruthy(),
    );
    expect(boundary.calls).toEqual(['usage.sources.discover']);

    await screen.pressByTestIdAsync(`${card}.add`);
    await vi.waitFor(() =>
      expect(screen.findByTestId(`${card}.stop`)).toBeTruthy(),
    );
    expect(boundary.calls).toEqual([
      'usage.sources.discover',
      'usage.sources.consent.set',
    ]);
    expect(screen.findByTestId(`${card}.add`)).toBeFalsy();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('hides a found card on Not now without consenting or deleting anything', async () => {
    const boundary = machineBoundary();
    const screen = await mount(boundary.executor);
    const card = 'sources.machine.mac.source.claude-default';
    await vi.waitFor(() =>
      expect(screen.findByTestId(`${card}.notNow`)).toBeTruthy(),
    );
    await screen.pressByTestIdAsync(`${card}.notNow`);
    await vi.waitFor(() => expect(screen.findByTestId(card)).toBeFalsy());
    expect(boundary.calls).toEqual(['usage.sources.discover']);
  });
});
