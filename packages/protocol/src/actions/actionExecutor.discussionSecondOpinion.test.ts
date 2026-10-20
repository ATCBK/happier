import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ActionIdSchema } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { DiscussionCreateResultV1Schema, DiscussionOpenedMessageV1Schema, DiscussionInviteInputV1Schema } from '../discussions/actions.js';
import { DiscussionSecondOpinionPreviewV1Schema } from '../discussions/secondOpinion.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import type { DiscussionSecondOpinionReviewerV1 } from '../discussions/secondOpinion.js';
import { readDiscussionSecondOpinionModelChildV1 } from '../discussions/secondOpinionActions.js';
import { ArtifactDocumentV1Schema } from '../artifacts/artifactActionsV1.js';
import { ApprovalRequestV2Schema, requiresExactDaemonApprovalReplay, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition } from '../approvals/approvalRequestTransition.js';

const request = {
  intent: 'preview', title: 'Review this answer', question: 'What would you change?',
  source: { kind: 'session', message: { kind: 'session', session: { serverId: 'home', sessionId: 'source' }, messageId: 'answer' } },
  reviewers: [{ selection: { kind: 'session', session: { serverId: 'home', sessionId: 'reviewer' } } }],
  retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' },
} as const;

function fixture(options: { needsGrant?: boolean; quoteOnly?: boolean; sourceReady?: boolean; lostCreate?: boolean; lostPost?: boolean;
  reviewer?: DiscussionSecondOpinionReviewerV1; sourcePages?: 'paged' | 'truncated'; lostGrant?: boolean;
  publisherSessionId?: string; publisherDisclosure?: boolean; noReviewers?: boolean } = {}) {
  const events: string[] = [];
  const creates: unknown[] = [], posts: unknown[] = [], invites: unknown[] = [];
  const speakers = new Map<string, 'when_addressed' | 'reads_only' | 'drafts_for_approval' | 'watches_and_speaks_up'>();
  const births: Parameters<NonNullable<ActionExecutorDeps['sessionSpawnNew']>>[0][] = [];
  const reviewer = options.reviewer ?? request.reviewers[0];
  let grantReady = !options.needsGrant, createLost = false, postLost = false, grantLost = false;
  const preview = () => DiscussionSecondOpinionPreviewV1Schema.parse({
    source: request.source, sourceContentReady: options.sourceReady ?? true, sourceAudienceAccountIds: grantReady ? ['alice', 'bob'] : ['alice'],
    discussionAudienceAccountIds: ['alice'], missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: true,
    ...(options.publisherSessionId ? { publisher: { sessionId: options.publisherSessionId, answerPolicy: 'when_addressed',
      audienceAccountIds: ['alice'], disclosure: options.publisherDisclosure === false
        ? { ok: false, reason: 'destination_audience_broader' } : { ok: true } } } : {}),
    reviewers: options.noReviewers ? [] : [{ ...reviewer, sourceAccess: options.quoteOnly ? 'quote_only' : 'read',
      runtimeAccountId: 'alice', audienceAccountIds: ['alice', 'bob'], missingSourceAccountIds: grantReady ? [] : ['bob'],
      canGrantSource: true, disclosure: grantReady ? { ok: true } : { ok: false, reason: 'destination_audience_broader' } }],
  });
  const message = (id: string, seq: number) => DiscussionOpenedMessageV1Schema.parse({
    id, discussionId: 'opinion', localId: id === 'quote' ? request.retry.quoteLocalId : request.retry.questionLocalId, seq,
    authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1, mentionedAccountIds: [],
    content: { v: 1, parts: [{ t: 'text', text: id === 'quote' ? 'Exact source answer' : request.question }] },
    messageRef: { kind: 'discussion', discussion: { serverId: 'home', discussionId: 'opinion' }, messageId: id },
  });
  const created = () => DiscussionCreateResultV1Schema.parse({ v: 1, serverId: 'home', firstMessage: message('quote', 1), discussion: {
    id: 'opinion', ownerAccountId: 'alice', access: 'owner', encryptionMode: 'plain', keyReadiness: true, dataEncryptionKey: null,
    anchor: { kind: 'session', sessionId: 'source', messageId: 'answer' }, creationLocalId: request.retry.creationLocalId,
    title: request.title, latestMessage: { id: 'quote', localId: request.retry.quoteLocalId, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
    messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
    capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
  } });
  // These are the host's HTTP/transcript transport ports. The real Action
  // executor, schemas, composition and semantic child builders remain intact.
  const executor = createActionExecutor({
    discussionAction: async args => {
      events.push(args.actionId);
      if (args.actionId === 'discussion.second_opinion.start') return { ok: true, value: preview() };
      if (args.actionId === 'discussion.create') {
        creates.push(args.input);
        if (options.lostCreate && !createLost) { createLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
        return created();
      }
      if (args.actionId === 'discussion.participants.list') return { discussionId: 'opinion', ownerAccountId: 'alice', access: 'owner', grants: [],
        participants: [...speakers].map(([sessionId, answerPolicy]) => ({ participant: { kind: 'session', sessionId }, answerPolicy, createdAt: 1 })) };
      if (args.actionId === 'discussion.invite') { invites.push(args.input);
        const invite = DiscussionInviteInputV1Schema.parse(args.input);
        if (invite.participant.kind === 'session') speakers.set(invite.participant.sessionId, invite.answerPolicy ?? 'when_addressed');
        return { discussionId: 'opinion', ownerAccountId: 'alice', access: 'owner', grants: [], changed: true,
        ...(reviewer.selection.kind === 'model' ? { modelParticipant: {
          participant: { kind: 'model', participantSlotId: reviewer.participantSlotId }, launch: reviewer.selection.launch,
          sessionId: null, answerPolicy: 'when_addressed', createdAt: 1,
        } } : {}) }; }
      if (args.actionId === 'discussion.post') {
        posts.push(args.input);
        if (options.lostPost && !postLost) { postLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
        return { v: 1, serverId: 'home', message: message('question', 2), messageSeq: 2 };
      }
      throw new Error(`Unexpected HTTP boundary ${args.actionId}`);
    },
    sessionAccessAction: async args => {
      events.push(args.actionId);
      grantReady = true;
      if (options.lostGrant && !grantLost) { grantLost = true; return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }; }
      return { changed: true, grant: { subject: { kind: 'account', accountId: 'bob' }, accessLevel: 'view', canApprovePermissions: false } };
    },
    sessionSpawnNew: async args => {
      births.push(args);
      return { type: 'success', disposition: 'rejoined', sessionId: 'allocated-reviewer', executionTarget: args.executionTarget,
        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
    },
    sessionTranscriptGet: async args => {
      events.push('read-source');
      const firstPage = options.sourcePages === 'paged' && !args.cursor;
      return { ok: true, sessionId: 'source', items: firstPage ? [] : [{ id: 'answer', semanticRole: 'assistant', role: 'assistant', kind: 'message',
        createdAt: 1, text: 'Exact source answer', ...(options.sourcePages === 'truncated' ? { truncated: true } : {}) }],
        nextCursor: firstPage ? 'next-source-page' : null, hasMore: firstPage,
        diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
    },
  } as ActionExecutorDeps);
  const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: 'home', bypassApprovals: true,
    actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
      'discussion.second_opinion.start': ['ui'], 'discussion.create': ['ui'], 'discussion.invite': ['ui'],
      'discussion.post': ['ui'], 'session.access.grant.set': ['ui'], 'session.transcript.get': ['ui'], 'session.spawn_new': ['ui'],
    } }) };
  return { executor, context, events, creates, posts, preview, births, invites };
}

describe('Second opinion canonical Action composition', () => {
  it('previews a people-only Discuss source without requiring an unused reviewer question', async () => {
    const f = fixture({ noReviewers: true });
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, reviewers: [], question: '' }, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(f.creates).toEqual([]);
  });
  it('lets Voice propose ordinary human approval, never turn a waiver into disclosure authority', async () => {
    const approvals: ApprovalRequestV2[] = [];
    const effects: string[] = [];
    const executor = createActionExecutor({
      discussionAction: async ({ actionId }) => { effects.push(actionId); throw new Error('No disclosure before approval'); },
      approvalsCreate: async ({ request: approval }) => {
        approvals.push(ApprovalRequestV2Schema.parse(approval)); return { artifactId: 'voice-opinion-approval' };
      },
    });
    const context = { serverId: 'home', runtimeAccountId: 'alice', actionRequestId: 'voice-request',
      defaultSessionId: 'source', defaultSessionMachineId: 'machine', actionCaller: { kind: 'host' as const },
      surface: 'voice' as const, authority: 'account_automation' as const,
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) };
    const result = await executor.execute('discussion.second_opinion.start', request, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'voice-opinion-approval' } });
    expect(approvals[0]).toMatchObject({ actionId: 'discussion.second_opinion.start', actionArgs: request, status: 'open' });
    expect(effects).toEqual([]);
    expect(await executor.execute('discussion.second_opinion.start', request, { ...context,
      actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: { 'discussion.second_opinion.start': ['voice'] } }) }))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(effects).toEqual([]);
  });
  it('retains Voice source privacy attribution when the actual person approves its preview', async () => {
    let stored: ApprovalRequestV2 | null = null;
    const reads: Array<{ surface: unknown; authority: unknown }> = [];
    const f = fixture();
    const executor = createActionExecutor({
      approvalsCreate: async ({ request: approval }) => { stored = ApprovalRequestV2Schema.parse(approval); return { artifactId: 'voice-preview' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request: next }) => {
        if (!stored) throw new Error('No retained approval');
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(next); return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
      discussionAction: async () => ({ ok: true, value: f.preview() }),
      sessionTranscriptGet: async ({ context }) => {
        reads.push({ surface: context.surface, authority: context.authority });
        return { ok: true, sessionId: 'source', items: [{ id: 'answer', createdAt: 1, semanticRole: 'assistant',
          role: 'assistant', kind: 'message', text: 'Exact source answer' }], nextCursor: null, hasMore: false,
          diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } };
      },
    });
    expect(await executor.execute('discussion.second_opinion.start', request, { serverId: 'home', runtimeAccountId: 'alice',
      actionRequestId: 'voice-preview', actionCaller: { kind: 'host' }, surface: 'voice', authority: 'account_automation',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(reads).toEqual([]);
    const result = await executor.execute('approval.request.decide', { artifactId: 'voice-preview', decision: 'approve' },
      { serverId: 'home', runtimeAccountId: 'alice', surface: 'ui', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'executed',
      execution: { ok: true, result: { status: 'preview' } } } });
    expect(reads).toEqual([{ surface: 'voice', authority: 'present_user' }]);
  });
  it('keeps an approved Agent root at its exact Session publisher instead of rebinding it to the deciding app', async () => {
    let stored: ApprovalRequestV2 | null = null;
    const readStored = () => stored;
    const callers: unknown[] = [];
    const executor = createActionExecutor({
      discussionAction: async ({ context }) => { callers.push(context.actionCaller);
        return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' }; },
      approvalsCreate: async ({ request: approval }) => { stored = ApprovalRequestV2Schema.parse(approval); return { artifactId: 'agent-preview' }; },
      approvalsGet: async () => stored,
      approvalsUpdate: async ({ request: next }) => {
        if (!stored) throw new Error('No retained approval');
        const transition = decideApprovalRequestTransition(stored, next);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(next); return { ok: true };
      },
      isApprovalExecutionOriginCurrent: async () => true,
    });
    expect(await executor.execute('discussion.second_opinion.start', request, { serverId: 'home', runtimeAccountId: 'alice',
      actionRequestId: 'agent-preview', actionCaller: { kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 },
      defaultSessionId: 'source', defaultSessionMachineId: 'machine', surface: 'agent', authority: 'account_automation',
      actionsSettings: normalizeActionsSettingsV1({ v: 1 }) })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    const approval = readStored();
    if (!approval) throw new Error('No retained approval');
    expect(requiresExactDaemonApprovalReplay(approval)).toBe(true);
    const result = await executor.execute('approval.request.decide', { artifactId: 'agent-preview', decision: 'approve' },
      { serverId: 'home', runtimeAccountId: 'alice', surface: 'ui', authority: 'present_user' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'failed',
      execution: { ok: false, errorCode: 'source_unavailable' } } });
    expect(callers).toEqual([{ kind: 'session', sessionId: 'source', starterDepth: 0, turnDepth: 0 }]);
  });
  it('previews without grants or create, then explicitly grants and asks through the ordinary Discussion path', async () => {
    const f = fixture({ needsGrant: true });
    const preview = await f.executor.execute('discussion.second_opinion.start', request, f.context);
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { status: 'preview', sourceText: 'Exact source answer' } });
    expect(f.events).toEqual(['discussion.second_opinion.start', 'read-source']);
    const result = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'asked', mode: 'ask',
      discussion: { serverId: 'home', discussionId: 'opinion' }, messageRef: { messageId: 'question' }, grantedAccountIds: ['bob'] } });
    expect(f.events.slice(2)).toEqual(['discussion.second_opinion.start', 'read-source', 'session.access.grant.set',
      'discussion.second_opinion.start', 'discussion.create', 'discussion.invite', 'discussion.post']);
    expect(f.creates[0]).toMatchObject({ creationLocalId: request.retry.creationLocalId,
      anchor: { kind: 'session', sessionId: 'source', messageId: 'answer' },
      firstMessage: { localId: request.retry.quoteLocalId, content: { parts: [{ t: 'text', text: 'Exact source answer' }] } } });
    expect(f.posts[0]).toMatchObject({ localId: request.retry.questionLocalId, replyTarget: { kind: 'message', messageId: 'quote' },
      content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'reviewer' } }, { t: 'text', text: ` ${request.question}` }] } });
  });

  it.each(['create', 'post'] as const)('rejoins the same resource and question after a lost %s response', async stage => {
    const f = fixture(stage === 'create' ? { lostCreate: true } : { lostPost: true });
    const ask = { ...request, intent: 'ask', confirmedPreview: f.preview() };
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true, result: { status: 'pending', errorCode: 'outcome_unknown' } });
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.creates[0]).toEqual(f.creates[1]);
    if (stage === 'post') expect(f.posts[0]).toEqual(f.posts[1]);
  });

  it('refuses quote-only disclosure and missing source keys before any mutation', async () => {
    const locked = fixture({ sourceReady: false });
    expect(await locked.executor.execute('discussion.second_opinion.start', request, locked.context)).toMatchObject({ ok: false, errorCode: 'encryption_material_unavailable' });
    expect(locked.events).toEqual(['discussion.second_opinion.start']);
    const quote = fixture({ needsGrant: true, quoteOnly: true });
    expect(await quote.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: quote.preview() }, quote.context))
      .toMatchObject({ ok: false, errorCode: 'discussion_access_forbidden' });
    expect(quote.creates).toEqual([]);
    expect(quote.events).not.toContain('session.access.grant.set');
  });

  it('requires renewed confirmation when the actual destination audience expands', async () => {
    const f = fixture();
    const confirmed = f.preview();
    confirmed.reviewers[0]!.audienceAccountIds = ['alice'];
    expect(await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: confirmed }, f.context))
      .toMatchObject({ ok: true, result: { status: 'preview_changed' } });
    expect(f.creates).toEqual([]);
  });
  it('rejoins a committed source grant after its response is lost without inventing another recipient', async () => {
    const f = fixture({ needsGrant: true, lostGrant: true });
    const ask = { ...request, intent: 'ask', confirmedPreview: f.preview() };
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true,
      result: { status: 'pending', stage: 'grant', errorCode: 'outcome_unknown' } });
    expect(await f.executor.execute('discussion.second_opinion.start', ask, f.context)).toMatchObject({ ok: true,
      result: { status: 'asked' } });
    expect(f.events.filter(event => event === 'session.access.grant.set')).toHaveLength(1);
    expect(f.creates).toHaveLength(1);
  });

  it('finds the exact committed source beyond the first page and never accepts truncated source text', async () => {
    const f = fixture({ sourcePages: 'paged' });
    expect(await f.executor.execute('discussion.second_opinion.start', request, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText: 'Exact source answer' } });
    const truncated = fixture({ sourcePages: 'truncated' });
    expect(await truncated.executor.execute('discussion.second_opinion.start', request, truncated.context)).toMatchObject({ ok: false,
      errorCode: 'discussion_content_unavailable' });
    expect(truncated.creates).toEqual([]);
  });

  it('asks a selected model only after its ordinary Session is allocated and targets that exact Session', async () => {
    const reviewer: DiscussionSecondOpinionReviewerV1 = { participantSlotId: 'opinion-reviewer-slot', selection: { kind: 'model', launch: {
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/work' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agents', localId: 'reviewer' } }, permissionMode: 'read-only',
    } } };
    const f = fixture({ reviewer });
    const ask = { ...request, reviewers: [reviewer], intent: 'ask', confirmedPreview: f.preview() };
    const result = await f.executor.execute('discussion.second_opinion.start', ask, f.context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.births).toHaveLength(1);
    expect(f.births[0]).toMatchObject({ discussionParticipant: { discussionId: 'opinion', participantSlotId: 'opinion-reviewer-slot' } });
    expect(f.births[0]?.initialInput).toBeUndefined();
    const publicSpawn = f.births[0]?.admittedInput;
    expect(readDiscussionSecondOpinionModelChildV1(ask, 'machine', publicSpawn)).toMatchObject({
      spawn: { creationKey: 'opinion-reviewer-slot', initialTriggers: [],
        discussionParticipant: { discussionId: 'opinion', participantSlotId: 'opinion-reviewer-slot' } },
    });
    expect(readDiscussionSecondOpinionModelChildV1(ask, 'machine', { ...publicSpawn,
      initialInput: { text: 'unreviewed work' } })).toBeNull();
    expect(f.posts[0]).toMatchObject({ content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'allocated-reviewer' } },
      { t: 'text', text: ` ${request.question}` }] } });
  });
  it('admits the actual publishing Agent Session as a speaker without addressing it or forging a different publisher', async () => {
    const f = fixture({ publisherSessionId: 'source' });
    const context = { ...f.context, actionCaller: { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 } };
    const outcome = await f.executor.execute('discussion.second_opinion.start', { ...request, intent: 'ask', confirmedPreview: f.preview() }, context);
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, result: { status: 'asked' } });
    expect(f.invites[0]).toMatchObject({ participant: { kind: 'session', sessionId: 'source' }, answerPolicy: 'when_addressed' });
    expect(f.posts[0]).toMatchObject({ content: { parts: [{ t: 'mention', participant: { kind: 'session', sessionId: 'reviewer' } },
      { t: 'text', text: ` ${request.question}` }] } });
    const foreign = fixture({ publisherSessionId: 'foreign' });
    expect(await foreign.executor.execute('discussion.second_opinion.start', request, context)).toMatchObject({ ok: false,
      errorCode: 'invalid_action_output' });
    expect(foreign.creates).toEqual([]);
  });
  it('withholds source text from an invoking Agent whose own runtime audience was not admitted', async () => {
    const f = fixture({ publisherSessionId: 'source', publisherDisclosure: false });
    const context = { ...f.context, actionCaller: { kind: 'session' as const, sessionId: 'source', starterDepth: 0, turnDepth: 0 } };
    expect(await f.executor.execute('discussion.second_opinion.start', request, context)).toMatchObject({ ok: false,
      errorCode: 'discussion_access_forbidden' });
    expect(f.events).not.toContain('read-source');
    expect(f.creates).toEqual([]);
  });
  it('opens a revision-qualified Doc passage through its real source Action and refuses a fabricated quote', async () => {
    const ref = { kind: 'doc' as const, artifactId: 'doc', serverId: 'home' };
    const revision = { headerVersion: 1, bodyVersion: 2 };
    const source = { kind: 'doc_passage' as const, passage: { ref, revision, range: { start: 9, end: 18 }, quote: 'Read this' } };
    const artifact = ArtifactDocumentV1Schema.parse({ artifactId: 'doc', ownerAccountId: 'alice', access: 'owner',
      header: { title: 'Notes', kind: 'markdown' }, body: '# Notes\n\nRead this.', revision,
      publicAudience: 'none', seq: 1, createdAt: 1, updatedAt: 1 });
    const f = fixture();
    const executor = createActionExecutor({
      discussionAction: async ({ actionId }) => {
        // Doc reads also project current readable passage-thread counts.
        if (actionId === 'discussion.list') return { v: 1, serverId: 'home', discussions: [], nextCursor: null, incomplete: false };
        if (actionId !== 'discussion.second_opinion.start') throw new Error('Preview must not write');
        return { ok: true, value: { ...f.preview(), source: { kind: 'doc_passage', doc: { ref, revision } } } };
      },
      artifactAction: async ({ actionId }) => {
        if (actionId !== 'artifact.get') throw new Error('Preview must not write');
        return { artifact };
      },
    });
    expect(await executor.execute('discussion.second_opinion.start', { ...request, source }, f.context)).toMatchObject({ ok: true,
      result: { status: 'preview', sourceText: 'Read this' } });
    expect(await executor.execute('discussion.second_opinion.start', { ...request,
      source: { ...source, passage: { ...source.passage, quote: 'Invented!' } } }, f.context)).toMatchObject({ ok: false,
      errorCode: 'discussion_content_unavailable' });
  });
  it('exposes one admitted Action with dangerous disclosure defaults on every public surface', () => {
    const parsed = ActionIdSchema.safeParse('discussion.second_opinion.start');
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const spec = getActionSpec(parsed.data);
    expect(spec.safety).toBe('danger');
    expect(spec.surfaces).toMatchObject({ ui: true, agent: true, cli: true, mcp: true, voice: true });
    expect(spec.inputSchema.safeParse(request).success).toBe(true);
  });

  it('reports Fresh opinions unavailable before any effects when its real workflow producer is absent', async () => {
    let effects = 0;
    const executor = createActionExecutor({ discussionAction: async () => { effects++; throw new Error('No effects before Fresh opinions admission'); } });
    const id = ActionIdSchema.safeParse('discussion.second_opinion.start');
    expect(id.success).toBe(true);
    if (!id.success) return;
    const result = await executor.execute(id.data, { ...request, intent: 'ask', reviewers: [request.reviewers[0],
      { selection: { kind: 'session', session: { serverId: 'home', sessionId: 'other-reviewer' } } }] },
    { surface: 'ui', authority: 'present_user', serverId: 'home', bypassApprovals: true });
    expect(result).toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'fresh_opinions_unavailable', mode: 'fresh_opinions' } });
    expect(effects).toBe(0);
  });
});
