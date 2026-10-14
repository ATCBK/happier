import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
let dockedTerminals: readonly string[] = [];
vi.mock('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/sessions/terminal/sessionTerminalWorkspaceRuntime')>()),
  subscribeSessionTerminalWorkspace: () => () => {},
  readSessionTerminalWorkspaceForScope: () => ({ tabs: [{ terminals: dockedTerminals.map(terminalId => ({
    id: `member-${terminalId}`, target: { kind: 'terminal_view', machineId: 'machine', terminalId } })) }] }),
}));
vi.mock('@/components/projects/panes/details/views/WorkspaceEmbeddedTerminalPane', () => ({
  WorkspaceEmbeddedTerminalPane: () => React.createElement('InlineTerminal'),
}));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));

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
  const render = async () => {
    const { ProjectCommandOutputPane } = await import('./ProjectCommandOutputPane');
    const { ProjectCommandOutputHost } = await import('./projectCommandOutputHost');
    return renderScreen(<ProjectCommandOutputHost scopeId="project:scope">
      <ProjectCommandOutputPane operation={withTerminal} title="test" onOpenInTerminal={() => {}} />
    </ProjectCommandOutputHost>);
  };

  it('mounts the PTY inline when the host tab does not show it', async () => {
    dockedTerminals = [];
    const screen = await render();
    expect(screen.findByTestId('project-command-output')).not.toBeNull();
    expect(screen.findByTestId('project-command-output.docked')).toBeNull();
    await screen.unmount();
  });

  it('keeps one surface for the PTY: the host tab owns it and the page points there', async () => {
    dockedTerminals = ['pty-1'];
    const screen = await render();
    expect(screen.findByTestId('project-command-output')).toBeNull();
    expect(screen.findByTestId('project-command-output.docked')).not.toBeNull();
    expect(screen.findByTestId('project-command-output.openInTerminal')).not.toBeNull();
    await screen.unmount();
  });
});
