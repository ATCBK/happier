import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { SessionServerStartSpawnDraftV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';

vi.mock('socket.io-client', async (importOriginal) => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
  renderCustomModals: true, confirmResult: true,
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const { Modal, ModalProvider } = await import('@/modal');
const { presentDiscussionSecondOpinion } = await import('./DiscussionSecondOpinionSheet');
const { SessionServerStartDraftComposerModal } = await import('@/components/sessions/new/SessionServerStartDraftComposerModal');
const { storage } = await import('@/sync/domains/state/storageStore');
let boundary: SessionListQuerySourceHarness;
beforeEach(async () => {
  boundary = await createSessionListQuerySourceHarness();
  setRuntimeFetch(createSessionReadBatchFetchBoundary(boundary.http.request));
});
afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); await boundary.dispose(); });

async function mount() {
  const serverId = boundary.serverIds[1]!;
  boundary.setRows(serverId, ['source-session', 'reviewer-session', 'unopened-session']);
  boundary.http.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
  for (const id of ['source-session', 'reviewer-session', 'unopened-session']) {
    const session = createSessionFixture({ id, serverId, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
      metadata: { machineId: 'review-machine', path: '/work', host: 'laptop', flavor: 'codex' } });
    boundary.http.answer(serverId, `/v2/sessions/${id}`, { body: createPlainSessionByIdResponseFixture(session) });
  }
  boundary.http.answer(serverId, '/v1/sessions/source-session/messages', { body: { messages: [{
    id: 'committed-answer', seq: 7, localId: null, createdAt: 1, messageRole: 'agent',
    content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'The source answer.' } } },
  }], hasMore: false, nextBeforeSeq: null } });
  const source = { kind: 'session' as const, message: { kind: 'session' as const,
    session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } };
  const previewPath = '/v1/discussions/second-opinion/preview';
  boundary.http.answer(serverId, `POST ${previewPath}`, { select: input => {
    const request = input as { reviewers: Array<{ selection: unknown; participantSlotId?: string; sourceAccess?: string }> };
    return { body: { ok: true, value: DiscussionSecondOpinionPreviewV1Schema.parse({ source,
      sourceAudienceAccountIds: [boundary.accountId(serverId)], sourceContentReady: true,
      discussionAudienceAccountIds: [boundary.accountId(serverId)], missingDiscussionSourceAccountIds: [],
      discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: request.reviewers.map(reviewer => ({
        ...reviewer, sourceAccess: reviewer.sourceAccess ?? 'read', runtimeAccountId: boundary.accountId(serverId),
        audienceAccountIds: [boundary.accountId(serverId)], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true },
      })) }) } };
  } });
  boundary.http.answer(serverId, 'POST /v1/discussions', { status: 503, body: { error: 'unavailable' } });
  storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId,
    [serverId]: [createMachineFixture({ id: 'review-machine', active: false, activeAt: 0 })] } });
  const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
  await act(async () => { presentDiscussionSecondOpinion({ source, sourceText: 'The source answer.', intent: 'second_opinion',
    onNavigate: () => {}, }); });
  return { screen, serverId, previewPath };
}

it('chooses a model through ordinary setup, previews its retained slot, and creates only on explicit Ask', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('discussion-invite-model-review-machine')).not.toBeNull());
  expect(screen.getTextContent()).toContain((await import('@/text')).t('session.collaboration.readiness.cause.machineOffline'));
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.pressByTestIdAsync('discussion-invite-model-review-machine');
  await vi.waitFor(() => expect(screen.findAllByType(SessionServerStartDraftComposerModal)).toHaveLength(1));
  // The genuine presentation boundary returns the ordinary author's strict draft. It never allocates a Session.
  const draft = SessionServerStartSpawnDraftV1Schema.parse({ executionTarget: { serverId, machineId: 'review-machine' },
    directory: { kind: 'path', path: '/work' }, permissionMode: 'read-only', title: 'Migration reviewer',
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
  await act(async () => screen.findByType(SessionServerStartDraftComposerModal).props.onResolve(draft));
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  const previewInput = boundary.http.requestsFor(previewPath)[0]!.input as { reviewers: Array<{ selection: unknown; participantSlotId: string }> };
  expect(previewInput.reviewers).toEqual([{ selection: { kind: 'model', launch: expect.objectContaining({
    executionTarget: draft.executionTarget, permissionMode: 'read-only',
  }) }, participantSlotId: expect.any(String) }]);
  expect(screen.getTextContent()).toContain('Migration reviewer');
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  expect(boundary.http.requests.some(request => request.path.includes('/participants/invite'))).toBe(false);
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  const allPreviews = boundary.http.requestsFor(previewPath).map(request => request.input as { reviewers: unknown });
  expect(allPreviews.every(request => JSON.stringify(request.reviewers) === JSON.stringify(previewInput.reviewers))).toBe(true);
  await screen.unmount();
});

it('demands only the highlighted Session readiness and asks two reviewers as Fresh opinions where Workflows run', async () => {
  const { screen, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  expect(screen.findByTestId('second-opinion.reviewer:source-session')).toBeNull();
  const row = screen.findAllByTestId('second-opinion.reviewer:reviewer-session').find(node => typeof node.props.onHoverIn === 'function');
  if (!row) throw new Error('Expected the shared readiness hover boundary');
  await act(async () => row.props.onHoverIn());
  await vi.waitFor(() => expect(boundary.http.requests.some(request => request.path.split('?')[0] === '/v2/sessions/reviewer-session')).toBe(true));
  expect(boundary.http.requests.some(request => request.path.split('?')[0] === '/v2/sessions/unopened-session')).toBe(false);
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(2));
  const { t } = await import('@/text');
  const ask = () => screen.findByTestId('second-opinion.ask');
  await vi.waitFor(() => expect(ask()?.props.disabled).toBe(false));
  expect(screen.getTextContent()).toContain(t('session.collaboration.discussion.secondOpinion.askFreshOpinions', { count: 2 }));
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.pressByTestIdAsync('second-opinion.ask');
  // The Machine and folder Discussion Workflows run in is the multi-reviewer placement: without it the
  // composed Action refuses before any grant or create, so reaching create proves it travelled.
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  expect(screen.findByTestId('second-opinion.failed-diagnostic-target_unavailable')).toBeNull();
  await screen.unmount();
});

it('keeps Fresh opinions from asking until it knows where to run, and surfaces the typed refusal', async () => {
  const { screen, serverId, previewPath } = await mount();
  storage.setState({ machineListByServerId: { ...storage.getState().machineListByServerId, [serverId]: [] } });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await screen.pressByTestIdAsync('second-opinion.reviewer:unopened-session');
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(2));
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  expect(screen.findByTestId('second-opinion-machine-row')).not.toBeNull();
  // The controller boundary: a multi-reviewer Ask with no placement returns the Action's typed refusal.
  const { createDiscussionSecondOpinionController } = await import('./discussionSecondOpinionController');
  const controller = createDiscussionSecondOpinionController({ scope: { serverId, accountId: boundary.accountId(serverId) },
    availability: 'available', source: { kind: 'session', message: { kind: 'session',
      session: { serverId, sessionId: 'source-session' }, messageId: 'committed-answer' } },
    draft: { title: 'Second opinion', question: 'Is this right?', reviewers: [
      { selection: { kind: 'session', session: { serverId, sessionId: 'reviewer-session' } } },
      { selection: { kind: 'session', session: { serverId, sessionId: 'unopened-session' } } }] } });
  await controller.preview();
  const refused = await controller.ask({ project: null });
  expect(refused).toEqual({ kind: 'failed', errorCode: 'target_unavailable' });
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('retains the actual preview refusal code on the shared sheet error state', async () => {
  const { screen, serverId, previewPath } = await mount();
  boundary.http.answer(serverId, `POST ${previewPath}`, {
    status: 403, body: { error: 'discussion_access_forbidden' },
  });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed')).not.toBeNull());
  expect(screen.findByTestId('second-opinion.failed-diagnostic-discussion_access_forbidden')).not.toBeNull();
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  await screen.unmount();
});

it('retains the actual failed start code when the sheet holds partial progress', async () => {
  const { screen, serverId } = await mount();
  boundary.http.answer(serverId, 'POST /v1/discussions', {
    status: 403, body: { error: 'discussion_access_forbidden' },
  });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.pending')).not.toBeNull());
  expect(screen.findByTestId('second-opinion.pending-diagnostic-discussion_access_forbidden')).not.toBeNull();
  await screen.unmount();
});
