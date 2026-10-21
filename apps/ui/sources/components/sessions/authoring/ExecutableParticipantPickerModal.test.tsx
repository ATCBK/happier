import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutableParticipantSelectionV1Schema } from '@happier-dev/protocol/discussions/executableParticipants';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionParticipantManagement } from '@/components/discussions/DiscussionParticipantsPopover';
import { DiscussionInviteButton } from '@/components/discussions/DiscussionInviteSheet';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { presentExecutableParticipantPicker } from './ExecutableParticipantPickerModal';
import { useExecutableParticipantSections } from '@/components/discussions/useExecutableParticipantSections';
import { SessionServerStartSpawnDraftV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
  Platform: { OS: 'android', select: <T,>(options: { android?: T; default?: T; native?: T }) => options.android ?? options.native ?? options.default },
}));

const { Modal, ModalProvider } = await import('@/modal');
let boundary: SessionListQuerySourceHarness;
beforeEach(async () => {
  boundary = await createSessionListQuerySourceHarness();
  setRuntimeFetch(createSessionReadBatchFetchBoundary(boundary.http.request));
});
afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); await boundary.dispose(); });

async function captureHome() {
  const home = boundary.serverIds[1]!;
  boundary.http.answer(home, '/v1/teams/list', { body: { items: [], nextCursor: null } });
  const hook = await renderHook(() => useServerCredentialAccountScopeBindings([home]));
  await vi.waitFor(() => expect(hook.getCurrent().get(home)?.isCurrent()).toBe(true));
  return hook.getCurrent().get(home)!;
}

describe('host participant controller using the public picker', () => {
  it('withdraws a model setup result when its actual captured Account retires before selection', async () => {
    const accountLifetime = await captureHome();
    const serverId = accountLifetime.scope.serverId;
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'late-model', active: false, activeAt: 0 })] } });
    const choose = vi.fn();
    const hook = await renderHook(() => useExecutableParticipantSections({ accountLifetime, enabled: true,
      sessionsContext: 'Reviewer', onChoose: choose }));
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    const option = hook.getCurrent().sections.flatMap(section => section.options).find(option => option.id === 'model:late-model');
    expect(option).toBeDefined();
    await act(async () => option!.onSelect?.());
    const { SessionServerStartDraftComposerModal } = await import('@/components/sessions/new/SessionServerStartDraftComposerModal');
    await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftComposerModal)).toHaveLength(1));
    const complete = screen.findByType(SessionServerStartDraftComposerModal).props.onResolve;
    await act(async () => { await boundary.http.switchAccount(serverId, 'replacement-account'); });
    await vi.waitFor(() => expect(accountLifetime.isCurrent()).toBe(false));
    const draft = SessionServerStartSpawnDraftV1Schema.parse({ executionTarget: { serverId, machineId: 'late-model' },
      directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    await act(async () => complete(draft));
    expect(choose).not.toHaveBeenCalled();
    await screen.unmount();
  });
  it('demands an existing Session from the real Discussion participant sheet', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['discussion-bot', 'unopened-bot']);
    const session = createSessionFixture({ id: 'discussion-bot', serverId: home, encryptionMode: 'plain',
      metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    boundary.http.answer(home, '/v2/sessions/discussion-bot', { body: createPlainSessionByIdResponseFixture(session) });
    storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'discussion',
      ownerAccountId: accountLifetime.scope.accountId, access: 'owner', grants: [], participants: [] });
    const noEffect = async () => undefined;
    // Controlled management inputs are inert here: this test exercises highlight reads, never invitation.
    const management: DiscussionParticipantManagement = { roster, status: 'ready', errorCode: null, operation: { kind: 'idle' },
      modelParticipants: [], ownerLeave: { kind: 'closed' }, refresh: noEffect, inviteExecutable: noEffect,
      setPolicy: noEffect, remove: noEffect, sessionAddress: () => null, requestLeave: noEffect,
      transferAndLeave: noEffect, archiveInsteadOfLeave: noEffect, cancelLeave: () => true, retry: noEffect };
    const screen = await renderScreen(<DiscussionInviteButton scope={accountLifetime.scope} accountLifetime={accountLifetime}
      discussionId="discussion" discussionTitle="Release review" roster={roster} management={management}
       />);
    await screen.pressByTestIdAsync('session-discussion-invite');
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-session-discussion-bot')).not.toBeNull());
    const row = screen.findAllByTestId('discussion-invite-session-discussion-bot').find(node => typeof node.props.onHoverIn === 'function');
    if (!row) throw new Error('Expected the Discussion option hover boundary');
    await act(async () => row.props.onHoverIn());
    await vi.waitFor(() => expect(boundary.http.requests.some(request => request.path.split('?')[0] === '/v2/sessions/discussion-bot')).toBe(true));
    expect(boundary.http.requests.some(request => request.path.split('?')[0] === '/v2/sessions/unopened-bot')).toBe(false);
    await screen.unmount();
  });
  it('demands only the highlighted existing Session through the real picker host', async () => {
    const accountLifetime = await captureHome();
    const home = accountLifetime.scope.serverId;
    boundary.setRows(home, ['first-bot', 'second-bot']);
    storage.setState({ machineListByServerId: { [home]: [createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })] } });
    for (const id of ['first-bot', 'second-bot']) {
      const session = createSessionFixture({ id, serverId: home, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
      boundary.http.answer(home, `/v2/sessions/${id}`, { body: createPlainSessionByIdResponseFixture(session) });
    }
    const reads = () => boundary.http.requests.filter(request => /^\/v2\/sessions\/(first-bot|second-bot)$/.test(request.path.split('?')[0]!));
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    const signal = new AbortController();
    let result!: ReturnType<typeof presentExecutableParticipantPicker>;
    await act(async () => { result = presentExecutableParticipantPicker({ accountLifetime, multiple: true, signal: signal.signal }); });
    await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-session-first-bot')).not.toBeNull());
    expect(reads()).toEqual([]);
    const row = screen.findAllByTestId('discussion-invite-session-first-bot').find(node => typeof node.props.onHoverIn === 'function');
    if (!row) throw new Error('Expected the real participant option hover boundary');
    await act(async () => row.props.onHoverIn());
    await vi.waitFor(() => expect(reads().map(request => request.path.split('?')[0])).toEqual(['/v2/sessions/first-bot']));
    expect(screen.getTextContent()).toContain((await import('@/text')).t('session.collaboration.readiness.cause.machineOffline'));
    await act(async () => signal.abort());
    await expect(result).resolves.toBeNull();
    expect(reads().some(request => request.path.endsWith('/second-bot'))).toBe(false);
    await screen.unmount();
  });
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
