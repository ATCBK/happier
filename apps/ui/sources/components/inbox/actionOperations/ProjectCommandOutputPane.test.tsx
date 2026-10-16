import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AppPaneAction } from '@/components/appShell/panes/model/appPaneReducer';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

let viewportWidth = 1200;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  useWindowDimensions: () => ({ width: viewportWidth, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane', () => ({
  WorkspaceEmbeddedTerminalPane: () => React.createElement('InlineTerminal'),
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { AppPaneProvider, useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { buildProjectPaneScopeId } = await import('@/components/projects/detail/projectPaneScope');
const { EMPTY_TERMINAL_WORKSPACE } = await import('@/components/sessions/terminal/sessionTerminalWorkspace');
const { readSessionTerminalWorkspaceForScope } = await import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime');

beforeEach(async () => {
  viewportWidth = 1200;
  await loadSyncSingletonForTests();
  await homes.reset();
  storage.getState().applyLocalSettings({ appPaneScopesV1: {} });
});

describe('terminal-less Project command output', () => {
  it.each(['projectCommand', 'machineEnvironment'] as const)('shows canonical terminal-less $0 review, uncertainty and settled states', async (kind) => {
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const base: ActionOperationProjection = {
      serverId: 'home', observation: 'available', isUnavailableProjection: false,
      snapshot: { version: 1, operationId: 'op', revision: 1, actionId: 'projects.prepare', state: 'accepted',
        scope: { accountId: 'account', machineId: 'machine' }, title: 'Setup', createdAt: 1, cancellation: 'supported',
        domainRef: kind === 'machineEnvironment' ? { kind, serverId: 'home', machineId: 'machine', preset: { id: 'preset', revision: 4 } }
            : { kind, purpose: 'setup', serverId: 'home', machineId: 'machine', workspaceRefId: 'workspace', cwd: '/repo' } },
    };
    for (const snapshot of [
      { ...base.snapshot, state: 'failed' as const, settledAt: 2 },
      { ...base.snapshot, state: 'cancelled' as const, settledAt: 2 },
      { ...base.snapshot, state: 'succeeded' as const, settledAt: 2 },
      { ...base.snapshot, setupReview: { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const, reviewedEffectDigest: 'effect', reviewedEffect: {} } },
      { ...base.snapshot, observation: { kind: 'outcome_uncertain' as const, code: 'lost' } },
    ]) {
      const screen = await renderScreen(<ProjectCommandOutputPane operation={{ ...base, snapshot }} title="Setup" />);
      expect(screen.findByTestId('project-command-output.pending')).toBeNull();
      expect(screen.findByTestId('project-command-output.status')).not.toBeNull();
      await screen.unmount();
    }
    const accepted = await renderScreen(<ProjectCommandOutputPane operation={base} title="Setup" />);
    expect(accepted.findByTestId('project-command-output.pending')).not.toBeNull();
  });
});

describe('Project command output with a docked terminal', () => {
  const withTerminal: ActionOperationProjection = {
    serverId: 'home', observation: 'available', isUnavailableProjection: false,
    snapshot: { version: 1, operationId: 'op', revision: 1, actionId: 'projects.script.run', state: 'running',
      scope: { accountId: 'account', machineId: 'machine' }, title: 'Test', createdAt: 1, cancellation: 'supported',
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'pty-1' } },
  };
  const render = async (host = true, openInTerminal = true) => {
    viewportWidth = openInTerminal ? 1200 : 390;
    const serverId = await homes.addHome({ name: 'Project Home', serverUrl: 'https://project-output.test', accountId: 'account' });
    storage.getState().activateProfileScope({ serverId, accountId: 'account' });
    await storage.getState().activateSettingsScope({ serverId, accountId: 'account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const scopeId = buildProjectPaneScopeId('workspace', serverId);
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const { ProjectCommandOutputHost, useProjectCommandOutputOpener } = await import('./projectCommandOutputHost');
    let pane: ReturnType<typeof useAppPaneContext> | undefined;
    function PaneOwner() {
      pane = useAppPaneContext();
      return null;
    }
    const operation: ActionOperationProjection = { ...withTerminal, serverId, snapshot: { ...withTerminal.snapshot,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/repo', terminalId: 'pty-1' } } };
    function OutputPane() {
      const output = useProjectCommandOutputOpener();
      return <ProjectCommandOutputPane operation={operation} title="test"
        onOpenInTerminal={output.opensInTerminal ? () => {} : undefined} onOpenDetail={() => {}} />;
    }
    const screen = await renderScreen(<AppPaneProvider>
      <PaneOwner />
      <ProjectCommandOutputHost scopeId={host ? scopeId : null}>
        <OutputPane />
      </ProjectCommandOutputHost>
    </AppPaneProvider>);
    const dispatch = async (action: AppPaneAction) => {
      await act(async () => {
        if (!pane) throw new Error('Pane owner is not mounted');
        pane.dispatch(action);
      });
    };
    await dispatch({ type: 'activateScope', scopeId });
    await dispatch({ type: 'setBottomTabState', scopeId, tabId: 'terminal',
      nextState: { ...EMPTY_TERMINAL_WORKSPACE, ownerScope: { serverId, accountId: 'account' } } });
    const openOutput = () => dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
      id: 'output-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-1', terminalKey: 'output-key', cwd: '/repo' },
    } } });
    return { screen, scopeId, dispatch, openOutput };
  };

  const expectInline = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
    expect(Boolean(screen.findHostByTestId('project-command-output'))).toBe(true);
    expect(Boolean(screen.findHostByTestId('project-command-output.docked'))).toBe(false);
  };
  const expectDocked = (screen: Awaited<ReturnType<typeof renderScreen>>) => {
    expect(Boolean(screen.findHostByTestId('project-command-output'))).toBe(false);
    expect(Boolean(screen.findHostByTestId('project-command-output.docked'))).toBe(true);
    expect(Boolean(screen.findByTestId('project-command-output.openInTerminal'))).toBe(true);
  };

  it('mounts the PTY inline when the host tab does not show it', async () => {
    const { screen } = await render();
    expectInline(screen);
    await screen.unmount();
  });

  it('keeps one surface for the PTY: the host tab owns it and the page points there', async () => {
    const { screen, openOutput } = await render();
    await openOutput();
    expectDocked(screen);
    await screen.unmount();
  });

  it('restores inline output when the retained bottom pane is hidden and docks it again when reopened', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    expectDocked(screen);
    await dispatch({ type: 'closeBottom', scopeId });
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(1);
    expectInline(screen);
    await dispatch({ type: 'openBottom', scopeId, tabId: 'terminal' });
    expectDocked(screen);
    await screen.unmount();
  });

  it('restores inline output when another terminal workspace tab is active', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'open', terminal: {
      id: 'other-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-2', terminalKey: 'other-key', cwd: '/repo' },
    } } });
    expectInline(screen);
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'focus', terminalId: 'output-member' } });
    expectDocked(screen);
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs).toHaveLength(2);
    await screen.unmount();
  });

  it('restores inline output when its retained pane scope is no longer active', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    expectDocked(screen);
    await dispatch({ type: 'activateScope', scopeId: 'another-project' });
    expectInline(screen);
    await dispatch({ type: 'activateScope', scopeId });
    expectDocked(screen);
    await screen.unmount();
  });

  it.each([
    { kind: 'builtin', id: 'tasks' },
    { kind: 'plugin', destination: { pluginId: 'example', localId: 'terminal' } },
  ] as const)('restores inline output when the bottom pane selects another destination: $kind', async (destination) => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'selectBottomDestination', scopeId, destination });
    expectInline(screen);
    await screen.unmount();
  });

  it('keeps every split member docked while another split member has focus', async () => {
    const { screen, scopeId, dispatch, openOutput } = await render();
    await openOutput();
    await dispatch({ type: 'terminalWorkspace', scopeId, command: { type: 'split', terminal: {
      id: 'split-member', target: { kind: 'terminal_view', machineId: 'machine', terminalId: 'pty-2', terminalKey: 'split-key', cwd: '/repo' },
    }, availableWidthPx: 1000, minimumTerminalWidthPx: 320 } });
    expect(readSessionTerminalWorkspaceForScope(scopeId)?.tabs[0]?.focusedTerminalId).toBe('split-member');
    expectDocked(screen);
    await screen.unmount();
  });

  it.each([
    { host: false, openInTerminal: true, name: 'no host' },
    { host: true, openInTerminal: false, name: 'phone/detail fallback' },
  ])('keeps inline output for $name', async ({ host, openInTerminal }) => {
    const { screen, openOutput } = await render(host, openInTerminal);
    await openOutput();
    expectInline(screen);
    await screen.unmount();
  });
});
