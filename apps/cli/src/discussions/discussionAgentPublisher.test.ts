import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { registerDiscussionAgentPublisher } from './discussionAgentPublisher';
import { createWorkflowAccountRunActionOwner, materializeWorkflowAcceptedSnapshotV1,
  sealWorkflowAcceptedSnapshotStoredEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { DurableWorkflowCoordinatorStore } from '@/daemon/workflows/production';
import { workflowInvocationKey } from '@/daemon/workflows/coordinator';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { WorkflowInvocationGetRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

describe('trusted Discussion reply publisher', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('keeps active explicit replies behind accepted Workflow output (workflow=%s)', async workflow => {
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' };
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { v: 1, status: 'available', progress: {
      v: 1, mode: workflow ? 'wait' : 'return', discussion: addressing, acceptedTurnId: 'turn', disposition: 'observing',
      ...(workflow ? { workflow: { purpose: 'invocation', runId: 'run', invocationRecordId: 'invocation' } } : {}),
    } } });
    const witness = { turnId: 'turn', inputId: 'input', discussionAddressing: addressing,
      userMessageSeq: 1, userMessageSeqs: [1] };
    const handlers = new Map<string, RpcHandler>();
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: { registerHandler: (id, handler) => { handlers.set(id, handler); } },
      serverId: 'home', serverUrl: 'https://home.test',
      readOwnerAccountCredentials: async () => ({ token: 'token', encryption: null }),
      isApprovalExecutionOriginCurrent: async () => false,
      session: { sessionId: 'receiver', getActiveTurnAdmissionWitness: () => witness,
        postAgentDiscussionMessage: async request => {
          posts.push(request);
          return { v: 1, ok: false, error: 'discussion_post_denied' };
        } },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1)!;
    expect(await handler({ witness, request: { v: 1, sessionId: 'receiver', discussionId: 'discussion',
      request: { localId: 'authored-id', content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'answer' }] } },
        mentionedAccountIds: [], mentionedSessionIds: [], replyTarget: { kind: 'message', messageId: 'question' } },
    } })).toMatchObject({ ok: false, error: 'discussion_post_denied' });
    expect(posts).toHaveLength(workflow ? 0 : 1);
  });

  it.each(['absent', 'origin_only', 'other_delivery', 'delivery'] as const)('opens the actual completed Workflow invocation and its frozen Discussion delivery (%s)', async binding => {
    const bound = binding === 'delivery';
    const throughSeq = binding === 'other_delivery' ? 3 : 2;
    const runId = '7be4d65c-d3b7-4868-a416-b18d9ee29c1c';
    const accountId = 'account';
    const recordId = 'invocation';
    const workflow = { purpose: 'invocation' as const, runId, invocationRecordId: recordId };
    const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
    const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq: 2, participantSessionId: 'receiver' };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, inputs: [], defaults: {
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
    },
      blocks: [{ kind: 'step', id: 'answer', document: { text: 'Answer', references: [], attachments: [] },
        input: [], result: { kind: 'text' }, execution: { conversation: { kind: 'fresh' } } }] },
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', ...(binding !== 'absent' ? { discussion: { discussion: { serverId: 'home', discussionId: 'discussion' },
          messageId: 'question', throughSeq } } : {}) },
        ...(bound || binding === 'other_delivery' ? { resultDelivery: { kind: 'originating_discussion' as const,
          discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'question', throughSeq } } : {}),
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId, runId }, acceptedSnapshot: accepted.snapshot }));
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine', accountId, origin: { kind: 'direct' }, acceptedEnvelope });
    const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: 'root', nextSequence: '1',
      frontier: { nextBlockOrdinal: 0, paused: false } };
    const root = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'invocation_progress', accountId, runId, recordId: 'root', sequence: '0',
        parentRecordId: null, memberOrdinal: '0', attempt: '0' },
      progress: { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: '$root', scope: [] },
        blockKind: 'root', attempt: '0', logicalInvocationRecordId: 'root' } }));
    await storage.execute({ operation: 'initialize', runId, expectedRevision: 0, checkpointEnvelope: 'unused',
      rootInvocation: { id: 'root', contentEnvelope: root } });
    const store = await DurableWorkflowCoordinatorStore.load({ accountId, runId, parentAttempt: 0, rootRecordId: 'root',
      revision: storage.run().revision, checkpoint, storage,
      encryption: { witness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, runCrypto: { mode: 'plain' } } });
    const key = workflowInvocationKey({ runId, blockId: 'answer', scope: [], attempt: 0 });
    await store.ensureIntent({ key, recordId, runId, blockId: 'answer', path: { blockId: 'answer', scope: [] },
      blockKind: 'step', memberOrdinal: '0', attempt: 0, acceptedAtMs: 1, lifecycle: 'pending' });
    await store.commitFact({ key, lifecycle: 'completed', result: 'accepted answer',
      execution: { kind: 'session', sessionId: 'receiver', localInputId: localId } });
    const owner = createWorkflowAccountRunActionOwner({ storage, resolveAccountId: async () => accountId,
      definitions: { get: async () => { throw new Error('No mutable definition read'); } },
      resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
      normalizeAbsolutePath: path => path, randomBytes: () => { throw new Error('Plain keys are absent'); } });
    let committed = false;
    vi.mocked(axios.get).mockImplementation(async url => {
      if (String(url).endsWith('/reply')) return { status: 200, data: { v: 1, status: 'available', progress: {
        v: 1, mode: 'wait', workflow, discussion: addressing, acceptedTurnId: 'turn', disposition: 'inline',
        outcome: committed ? { kind: 'answer', publicationRef: { kind: 'discussion',
          discussion: { serverId: 'home', discussionId: 'discussion' }, messageId: 'published' } }
          : { kind: 'answer', result: { sessionId: 'receiver', messageId: 'native-final' } },
      } } };
      return { status: 200, data: { discussion: { id: 'discussion', ownerAccountId: accountId, encryptionMode: 'plain',
        anchor: null, access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId: 'created',
        titleContent: { t: 'plain', v: { v: 1, title: 'Question' } }, messageSeq: 2, lastReadSeq: 0,
        unreadCount: 2, unreadMentionCount: 0, recentAuthorAccountIds: [accountId], archivedAt: null,
        latestMessage: { id: 'question', localId: 'question-local', seq: 2, authorAccountId: accountId,
          accountActor: { v: 1, accountId, profile: null }, producerV1: null, createdAt: 2 },
        capabilities: { postMessages: true, rename: true, archive: true, restore: false,
          askAgent: true, sendToSession: true, manageAccess: true, leave: false },
      } } };
    });
    const handlers = new Map<string, RpcHandler>();
    const posts: unknown[] = [];
    registerDiscussionAgentPublisher({ rpcHandlerManager: { registerHandler: (id, handler) => { handlers.set(id, handler); } },
      serverId: 'home', serverUrl: 'https://home.test', readOwnerAccountCredentials: async () => ({ token: 'token', encryption: null }),
      isApprovalExecutionOriginCurrent: async () => false,
      executeSourceAction: async (actionId, input, context) => actionId === 'workflow.run.invocations.get'
        ? { ok: true, result: await owner.execute({ actionId, input: WorkflowInvocationGetRequestV1Schema.parse(input), context }) }
        : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' },
      session: { sessionId: 'receiver', postAgentDiscussionMessage: async request => {
        posts.push(request); committed = true; return { v: 1, ok: false, error: 'discussion_post_denied' };
      } },
    });
    const handler = handlers.get(SESSION_RPC_METHODS.DISCUSSION_AGENT_POST_V1)!;
    const publication = (text: string, attempt = '0') => ({ request: { v: 1, sessionId: 'receiver', discussionId: 'discussion',
      replyReturn: { serverId: 'home', requestLocalId: localId, acceptedTurnId: 'turn',
        workflow: { runId, invocationRecordId: recordId, invocationAttempt: attempt } },
      request: { localId: deriveSessionMessageReplyReturnLocalIdV1({ sessionId: 'receiver', localId, acceptedTurnId: 'turn' }),
        content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text }] } }, mentionedAccountIds: [], mentionedSessionIds: [],
        replyTarget: { kind: 'message', messageId: 'question' } },
    } });
    await handler(publication('forged output'));
    await handler(publication('accepted answer', '1'));
    expect(posts).toEqual([]);
    await handler(publication('accepted answer'));
    expect(posts).toHaveLength(bound ? 1 : 0);
    await handler(publication('accepted answer'));
    expect(posts).toHaveLength(bound ? 2 : 0);
    if (bound) expect(posts[1]).toEqual(posts[0]);
  });
});
