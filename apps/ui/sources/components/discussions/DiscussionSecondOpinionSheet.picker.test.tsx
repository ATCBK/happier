import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionCreateRequestV1Schema } from '@happier-dev/protocol/discussions/api';
import { SessionServerStartSpawnDraftV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createDeferred, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionListQuerySourceHarness, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { answerDiscussionThreadForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { Item } from '@/components/ui/lists/Item';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';

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
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
let boundary: SessionListQuerySourceHarness;
beforeEach(async () => {
  boundary = await createSessionListQuerySourceHarness();
  setRuntimeFetch(createSessionReadBatchFetchBoundary(boundary.http.request));
});
afterEach(async () => { await act(async () => Modal.hideAll()); await standardCleanup(); await boundary.dispose(); });

function setSharing(serverId: string, enabled: boolean) {
  const features = createRootLayoutFeaturesResponse({ features: { sharing: { session: { enabled } },
    sessions: { enabled: true, filteredListing: { enabled: true } },
    encryption: { plaintextStorage: { enabled: true } } } });
  boundary.http.answer(serverId, '/v1/features', { body: features });
  boundary.http.answer(serverId, '/v1/features/authenticated', { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
}

async function mount(options: { sharingEnabled?: boolean; intent?: 'second_opinion' | 'discuss' } = {}) {
  const serverId = boundary.serverIds[1]!;
  if (options.sharingEnabled !== undefined) setSharing(serverId, options.sharingEnabled);
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
  await act(async () => { presentDiscussionSecondOpinion({ source, sourceText: 'The source answer.', intent: options.intent ?? 'second_opinion',
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
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
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
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
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
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
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

it('uses newly available sharing on the same mounted sheet without losing question or reviewer selection', async () => {
  const { screen, serverId, previewPath } = await mount({ sharingEnabled: false });
  const question = 'Keep this edited question';
  act(() => screen.changeTextByTestId('second-opinion.question', question));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed-diagnostic-unsupported_action')).not.toBeNull());
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  const selected = () => screen.findAllByType(Item).find(item => item.props.testID === 'second-opinion.reviewer:reviewer-session');
  expect(selected()?.props.selected).toBe(true);
  // A new canonical feature snapshot, without closing/reopening the Home or draft.
  await act(async () => setSharing(serverId, true));
  expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
  expect(selected()?.props.selected).toBe(true);
  await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(boundary.http.requestsFor('/v1/discussions').length).toBeGreaterThan(0));
  const previewInput = boundary.http.requestsFor(previewPath)[0]!.input as { reviewers: unknown[] };
  expect(previewInput.reviewers).toEqual([{ selection: { kind: 'session', session: { serverId, sessionId: 'reviewer-session' } } }]);
  expect(screen.findByTestId('second-opinion.question')?.props.value).toBe(question);
  await screen.unmount();
});

it('lets a retained Discuss draft preview, create and retry with the same identities after sharing changes', async () => {
  const { screen, serverId, previewPath } = await mount({ sharingEnabled: false, intent: 'discuss' });
  const thread = answerDiscussionThreadForTests(boundary.http, serverId, { accountId: boundary.accountId(serverId),
    loseCreate: true, loseFirstRejoin: false });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed-diagnostic-unsupported_action')).not.toBeNull());
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  await act(async () => setSharing(serverId, true));
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed')).not.toBeNull());
  expect(thread.stored()?.firstMessage.content).toEqual({ t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'The source answer.' }] } });
  const creates = () => boundary.http.requestsFor('/v1/discussions').filter(request => request.input != null)
    .map(request => DiscussionCreateRequestV1Schema.parse(request.input));
  const original = creates()[0]!;
  await act(async () => setSharing(serverId, false));
  await act(async () => setSharing(serverId, true));
  const retry = screen.findAllByType(SurfaceStateCard).find(card => card.props.testID === 'second-opinion.failed')?.props.action;
  if (!retry) throw new Error('Expected the retained creation retry control');
  await act(async () => { retry.onPress(); });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.open')).not.toBeNull());
  expect(creates()).toHaveLength(2);
  expect(creates().every(request => request.creationLocalId === original.creationLocalId
    && request.firstMessage.localId === original.firstMessage.localId)).toBe(true);
  expect(thread.messages).toHaveLength(1);
  await screen.unmount();
});

it('keeps an unavailable sheet closed when another Home publishes sharing enabled', async () => {
  const { screen, previewPath } = await mount({ sharingEnabled: false });
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed-diagnostic-unsupported_action')).not.toBeNull());
  await act(async () => setSharing(boundary.serverIds[2]!, true));
  expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(0);
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('recovers after availability changes during a pending preview without replacing the selected reviewer', async () => {
  const { screen, serverId, previewPath } = await mount();
  const release = createDeferred<void>();
  let pending = true;
  boundary.http.answer(serverId, `POST ${previewPath}`, { select: input => {
    if (pending) return { respondAfter: release.promise, status: 503, body: { error: 'unsupported_action' } };
    const request = input as { source: unknown; reviewers: Array<{ selection: unknown }> };
    return { body: { ok: true, value: DiscussionSecondOpinionPreviewV1Schema.parse({ source: request.source,
      sourceAudienceAccountIds: [boundary.accountId(serverId)], sourceContentReady: true,
      discussionAudienceAccountIds: [boundary.accountId(serverId)], missingDiscussionSourceAccountIds: [],
      discussionDisclosure: { ok: true }, canGrantSource: true, reviewers: request.reviewers.map(reviewer => ({
        ...reviewer, sourceAccess: 'read', runtimeAccountId: boundary.accountId(serverId),
        audienceAccountIds: [boundary.accountId(serverId)], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true },
      })) }) } };
  } });
  try {
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
    await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
    await vi.waitFor(() => expect(boundary.http.requestsFor(previewPath)).toHaveLength(1));
    await act(async () => setSharing(serverId, false));
    pending = false;
    await act(async () => setSharing(serverId, true));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(1);
    expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(true);
    await act(async () => release.resolve());
    await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(2);
    const inputs = boundary.http.requestsFor(previewPath).map(request => request.input);
    expect(inputs[1]).toEqual(inputs[0]);
    await act(async () => setSharing(serverId, true));
    expect(boundary.http.requestsFor(previewPath)).toHaveLength(2);
    expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  } finally {
    release.resolve();
    await screen.unmount();
  }
});

it('refuses an already previewed Ask when sharing becomes disabled on its Home', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  const previews = boundary.http.requestsFor(previewPath).length;
  await act(async () => setSharing(serverId, false));
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.failed-diagnostic-unsupported_action')).not.toBeNull());
  expect(boundary.http.requestsFor(previewPath)).toHaveLength(previews);
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('does not let a retained Ask use a replacement Account on the same Home', async () => {
  const { screen, serverId } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  const action = screen.findAllByType(RoundButton).find(button => button.props.testID === 'second-opinion.ask')?.props.action;
  expect(typeof action).toBe('function');
  await act(async () => { await boundary.switchAccount(serverId, 'replacement-account'); });
  await act(async () => { await action(); });
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});

it('rechecks source access before creating from a previously successful preview', async () => {
  const { screen, serverId, previewPath } = await mount();
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.reviewer:reviewer-session')).not.toBeNull());
  await screen.pressByTestIdAsync('second-opinion.reviewer:reviewer-session');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.ask')?.props.disabled).toBe(false));
  boundary.http.answer(serverId, `POST ${previewPath}`, { status: 403, body: { error: 'discussion_access_forbidden' } });
  await screen.pressByTestIdAsync('second-opinion.ask');
  await vi.waitFor(() => expect(screen.findByTestId('second-opinion.pending-diagnostic-discussion_access_forbidden')).not.toBeNull());
  expect(boundary.http.requestsFor('/v1/discussions')).toHaveLength(0);
  await screen.unmount();
});
