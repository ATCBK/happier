import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutableParticipantSelectionV1Schema } from '@happier-dev/protocol/discussions/executableParticipants';
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { presentExecutableParticipantPicker } from './ExecutableParticipantPickerModal';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Platform: { OS: 'android', select: <T,>(options: { android?: T; default?: T; native?: T }) => options.android ?? options.native ?? options.default },
}));

const { ModalProvider } = await import('@/modal');
let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { standardCleanup(); await boundary.dispose(); });

async function captureHome() {
  const home = boundary.serverIds[1]!;
  boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
  const hook = await renderHook(() => useServerCredentialAccountScopeBindings([home]));
  await vi.waitFor(() => expect(hook.getCurrent().get(home)?.isCurrent()).toBe(true));
  return hook.getCurrent().get(home)!;
}

describe('host participant controller using the public picker', () => {
  it('confirms an already configured model without a selected Session option id', async () => {
    const accountLifetime = await captureHome();
    const selected = ExecutableParticipantSelectionV1Schema.parse({ kind: 'model', launch: {
      executionTarget: { serverId: accountLifetime.scope.serverId, machineId: 'model-machine' },
      directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    let result!: ReturnType<typeof presentExecutableParticipantPicker>;
    await act(async () => { result = presentExecutableParticipantPicker({ accountLifetime, selected, multiple: true, signal: new AbortController().signal }); });
    expect(screen.findByTestId('executable-participant-picker-done')?.props.disabled).toBe(false);
    await act(async () => screen.pressByTestId('executable-participant-picker-done'));
    await expect(result).resolves.toEqual([selected]);
    await screen.unmount();
  });

  it('returns the selected captured-Home Session immediately without a separate confirmation', async () => {
    const accountLifetime = await captureHome();
    boundary.setRows(accountLifetime.scope.serverId, ['review-session']);
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    let result!: ReturnType<typeof presentExecutableParticipantPicker>;
    await act(async () => { result = presentExecutableParticipantPicker({ accountLifetime, multiple: false, signal: new AbortController().signal }); });
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-session-review-session')).not.toBeNull());
    expect(screen.findByTestId('executable-participant-picker-done')).toBeNull();
    await act(async () => screen.pressByTestId('discussion-invite-session-review-session'));
    await expect(result).resolves.toEqual({ kind: 'session', session: { serverId: accountLifetime.scope.serverId, sessionId: 'review-session' } });
    await screen.unmount();
  });
});
