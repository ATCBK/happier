import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { sealSessionStoredContent, type SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionStoredContentCodec';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createProductionWorkflowDiscussionContextReader, resolveWorkflowDiscussionOrigin } from './workflowDiscussion';

vi.mock('axios', () => ({ default: { request: vi.fn() } }));
const discussion = { serverId: 'server-1', discussionId: 'discussion-1' };
const origin = { discussion, messageId: 'question', throughSeq: 2 };
const serverHttpBaseUrl = 'https://workflow-discussion.test';
const features = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true,
  conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {} });

async function fixture(mode: 'plain' | 'e2ee') {
  const credentials = { token: 'token', encryption: mode === 'plain' ? null
    : { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) } };
  const key = await createResourceDataKey({ credentials, mode });
  const crypto: SessionStoredContentCryptoContext = key.mode === 'plain' ? { mode: 'plain', ctx: null }
    : { mode: 'e2ee', ctx: { encryptionKey: key.dataKey, encryptionVariant: 'dataKey' } };
  let latest = 3;
  let revoked = false;
  let locked = false;
  let revokeAfterFirstPage = false;
  const messages = Array.from({ length: 4 }, (_, i) => ({ id: i === 1 ? 'question' : `message-${i + 1}`,
    discussionId: discussion.discussionId, localId: `local-${i}`, seq: i + 1,
    authorAccountId: 'account', accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null,
    content: sealSessionStoredContent({ ...crypto, payload: { v: 1, parts: [{ t: 'text',
      text: i >= 2 ? 'peer sentinel' : `message ${i + 1}` }] } }), mentionedAccountIds: [], createdAt: i + 1 }));
  const reads: URL[] = [];
  vi.mocked(axios.request).mockImplementation(async request => {
    const url = new URL(String(request.url));
    if (url.pathname === '/v1/discussions/discussion-1') return { status: revoked ? 403 : 200, data: { discussion: {
      id: discussion.discussionId, ownerAccountId: 'account', encryptionMode: mode,
      titleContent: sealSessionStoredContent({ ...crypto, payload: { v: 1, title: 'Title' } }),
      dataEncryptionKey: locked ? null : key.dataEncryptionKey, keyReadiness: !locked, anchor: null, access: 'owner',
      latestMessage: { id: 'message-3', localId: 'local-2', seq: 3, authorAccountId: 'account',
        accountActor: { v: 1, accountId: 'account', profile: null }, producerV1: null, createdAt: 3 },
      creationLocalId: 'creation', messageSeq: latest, lastReadSeq: 0, unreadCount: latest, unreadMentionCount: 0,
      recentAuthorAccountIds: ['account'], archivedAt: null, capabilities: { postMessages: true, rename: true,
        archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
    } } };
    if (url.pathname.endsWith('/messages')) {
      reads.push(url);
      const frontier = Math.min(Number(url.searchParams.get('throughSeq') ?? latest), latest);
      const before = Number(url.searchParams.get('beforeSeq') ?? frontier + 1);
      const row = messages[Math.min(frontier, before - 1) - 1]!;
      latest = 4; // New peer reply arrives between pages.
      if (revokeAfterFirstPage) revoked = true;
      return { status: 200, data: { messages: [row], messageSeq: frontier, hasMoreOlder: row.seq > 1 } };
    }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  return { credentials, reads, revoke: () => { revoked = true; }, lock: () => { locked = true; },
    revokeAfterFirstPage: () => { revokeAfterFirstPage = true; } };
}

describe('Workflow production Discussion context', () => {
  beforeEach(() => {
    vi.mocked(axios.request).mockReset();
    vi.stubGlobal('fetch', async () => Response.json(features));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['plain', 'e2ee'] as const)('pages actual %s C3 content through the fixed addressing occurrence', async mode => {
    const state = await fixture(mode);
    const reader = createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin });
    const fixed = await reader.resolveDiscussionContext('addressing_message');
    expect(fixed).toMatchObject({ throughSeq: 2, messages: [{ id: 'message-1' }, { id: 'question' }] });
    expect(JSON.stringify(fixed)).not.toContain('peer sentinel');
    expect(state.reads.map(url => url.searchParams.get('throughSeq'))).toEqual(['2', '2']);
    state.reads.length = 0;
    const current = await reader.resolveDiscussionContext('so_far');
    expect(current).toMatchObject({ throughSeq: 4, messages: [
      { id: 'message-1' }, { id: 'question' }, { id: 'message-3' }, { id: 'message-4' },
    ] });
    expect(state.reads.slice(1).every(url => url.searchParams.get('throughSeq') === '4')).toBe(true);
  });

  it('derives start custody from the committed message instead of a local id or current frontier', async () => {
    const state = await fixture('plain');
    const discussionAction = createDiscussionActionDeps({ credentials: state.credentials, serverId: discussion.serverId,
      serverHttpBaseUrl, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }).discussionAction!;
    const context = { serverId: discussion.serverId, surface: 'cli' as const, authority: 'present_user' as const };
    expect(await resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion,
      addressingMessageId: 'question' }, context, discussionAction })).toEqual(origin);
    await expect(resolveWorkflowDiscussionOrigin({ origin: { kind: 'discussion', discussion,
      addressingMessageId: 'local-1' }, context, discussionAction })).rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
  });

  it.each(['revoked', 'locked'] as const)('refuses current %s access before returning any history', async failure => {
    const state = await fixture('e2ee');
    if (failure === 'revoked') state.revoke(); else state.lock();
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
    expect(state.reads).toEqual([]);
  });

  it('rejects a foreign or missing Discussion origin without a transport read', async () => {
    const state = await fixture('plain');
    for (const selected of [undefined, { ...origin, discussion: { ...discussion, serverId: 'other-home' } }]) {
      await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
        serverId: discussion.serverId, serverHttpBaseUrl, origin: selected }).resolveDiscussionContext('so_far'))
        .rejects.toMatchObject({ code: 'invalid_reference_scope' });
    }
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('does not return a partial context when access is revoked between history pages', async () => {
    const state = await fixture('plain');
    state.revokeAfterFirstPage();
    await expect(createProductionWorkflowDiscussionContextReader({ credentials: state.credentials,
      serverId: discussion.serverId, serverHttpBaseUrl, origin }).resolveDiscussionContext('addressing_message'))
      .rejects.toMatchObject({ code: 'workflow_discussion_context_unavailable' });
    expect(state.reads).toHaveLength(1);
  });
});
