import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';
import { getActionSpec } from './actionSpecs.js';
import { ActionsSettingsV1Schema } from './actionSettings.js';
import { encodeV2SessionListCursorV2 } from '../sessions/listing/cursor.js';
import { SessionReportsToSetResultV1Schema } from '../sessions/relations/sessionReportsToV1.js';
import type {
  SessionReportsToSetActionInputV1,
  SessionReportsToSetResultV1,
} from '../sessions/relations/sessionReportsToV1.js';

// These ports replace authenticated server HTTP adapters, not internal tree or admission logic.
function createTransportExecutor(overrides: Partial<ActionExecutorDeps>) {
  return createActionExecutor({
    executionRunStart: async () => ({}), executionRunList: async () => ({}), executionRunGet: async () => ({}),
    detachedExecutionRunSend: async () => ({}), executionRunStop: async () => ({}),
    executionRunAction: async () => ({}), executionRunWait: async () => ({}),
    sessionOpen: async () => ({}), sessionFork: async () => ({}), sessionRollback: async () => ({}),
    sessionSpawnNew: async () => ({}), pathsListRecent: async () => ({ items: [] }),
    machinesList: async () => ({ items: [] }), serversList: async () => ({ items: [] }),
    reviewEnginesList: async () => ({ items: [] }), agentsBackendsList: async () => ({ items: [] }),
    agentsModelsList: async () => ({ items: [] }), sessionSendMessage: async () => ({}),
    sessionPermissionRespond: async () => ({}), sessionUserActionAnswer: async () => ({}),
    sessionModeSet: async () => ({}), sessionModesList: async () => ({ items: [] }),
    sessionList: async () => ({ sessions: [] }), sessionActivityGet: async () => ({}),
    sessionRecentMessagesGet: async () => ({}),
    daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }),
    daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
    daemonMemoryEnsureUpToDate: async () => ({}), resetGlobalVoiceAgent: async () => {},
    ...overrides,
  });
}

const input = { sessionId: 'worker', leadSessionId: 'lead', expectedLeadSessionId: null };
const context = { surface: 'cli', authority: 'present_user', serverId: 'home', bypassApprovals: true } as const;

describe('session.worker.publish', () => {
  it('admits a caller-bound report with references and preserves typed producer refusals', async () => {
    const reports: unknown[] = [];
    const deliverables = [{ kind: 'workspace_file', sessionId: 'worker', path: 'result.md' }, { kind: 'artifact', artifactId: 'report' }];
    const executor = createTransportExecutor({
      sessionWorkerPublish: async ({ context: _context, ...report }) => {
        reports.push(report);
        return report.summary === 'allowed'
        ? { sessionId: 'worker', leadSessionId: 'lead', localId: 'report-1' }
        : { ok: false, errorCode: 'session_worker_requires_reports_to', error: 'session_worker_requires_reports_to' };
      },
    });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'worker' } as const;
    await expect(executor.execute('session.worker.publish', { summary: 'allowed', deliverables }, agent)).resolves.toMatchObject({
      ok: true, result: { sessionId: 'worker', leadSessionId: 'lead', localId: 'report-1' },
    });
    expect(reports).toEqual([{ summary: 'allowed', deliverables }]);
    await expect(executor.execute('session.worker.publish', { summary: 'allowed', leadSessionId: 'forged' }, agent)).resolves.toMatchObject({ ok: false });
    await expect(executor.execute('session.worker.publish', { summary: 'refused' }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'session_worker_requires_reports_to' });
    expect(getActionSpec('session.worker.publish').surfaces.cli).toBe(false);
  });
});

describe('session.reports_to.set', () => {
  it('keeps a committed relation successful while source-key preparation waits', async () => {
    const committed = { ok: true, sessionId: 'worker', leadSessionId: 'lead', attachedAt: 1,
      sourceKeyPreparation: { kind: 'waiting', reason: 'source_key_unavailable' } } as const;
    const executor = createTransportExecutor({ sessionReportsToSet: async () => committed });
    const result = await executor.execute('session.reports_to.set', input, context);
    expect(result).toEqual({ ok: true, result: committed });
    if (!result.ok) throw new Error('Committed relation was reported failed');
    expect(SessionReportsToSetResultV1Schema.parse(result.result)).toEqual(committed);
    expect(getActionSpec('session.reports_to.set').outputSchema!.parse(result.result)).toEqual(committed);
    expect(SessionReportsToSetResultV1Schema.safeParse({ ...committed,
      sourceKeyPreparation: { ...committed.sourceKeyPreparation, secret: 'invalid' },
    }).success).toBe(false);
  });

  it.each(['summary', 'awareness'] as const)('edits a child proved by %s but does not submit an unapproved outside-subtree mutation', async (view) => {
    const submittedAttachments: SessionReportsToSetActionInputV1[] = [];
    const sessionReportsToSet = async (request: SessionReportsToSetActionInputV1): Promise<SessionReportsToSetResultV1> => {
      submittedAttachments.push({
        sessionId: request.sessionId,
        leadSessionId: request.leadSessionId,
        expectedLeadSessionId: request.expectedLeadSessionId,
      });
      return { ok: true, sessionId: request.sessionId, leadSessionId: request.leadSessionId, attachedAt: 1 };
    };
    const sessionList = vi.fn(async () => view === 'awareness' ? {
      view: 'awareness', projectionVersion: 1,
      sessions: [{
        v: 1, sessionId: 'worker', lifecycle: 'active', runtime: 'idle', freshness: 'live',
        operational: { primary: 'none', reasons: [] }, encryption: 'plain', availability: 'complete',
      }],
      nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    } : {
      sessions: [{ id: 'worker', active: false, presence: 'offline', updatedAt: 10 }],
      nextCursor: null, hasNext: false, queryVersion: 1, attentionNextCursor: null, attentionHasNext: false,
    });
    const executor = createTransportExecutor({ sessionReportsToSet, sessionList, isActionApprovalRequired: () => false });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;
    await expect(executor.execute('session.reports_to.set', input, agent)).resolves.toMatchObject({ ok: true });
    await expect(executor.execute('session.reports_to.set', { ...input, sessionId: 'unrelated' }, agent)).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    expect(submittedAttachments).toEqual([input]);
    expect(sessionList).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ underSessionId: 'lead' }) }));
  });

  it('honors explicit require inside the subtree and waiver outside without granting input authority', async () => {
    const submittedAttachments: string[] = [];
    const executor = createTransportExecutor({
      sessionList: async () => ({ sessions: [], nextCursor: null, hasNext: false, queryVersion: 1, attentionNextCursor: null, attentionHasNext: false }),
      sessionReportsToSet: async ({ sessionId }) => {
        submittedAttachments.push(sessionId);
        return { ok: false, error: 'reports_to_forbidden', reason: 'input' };
      },
    });
    const agent = { surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead' } as const;
    await expect(executor.execute('session.reports_to.set', { ...input, sessionId: 'lead' }, {
      ...agent,
      actionsSettings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: { 'session.reports_to.set': { approvalRequiredSurfaces: ['agent'] } },
      }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
    await expect(executor.execute('session.reports_to.set', input, {
      ...agent,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: { 'session.reports_to.set': ['agent'] } }),
    })).resolves.toMatchObject({ ok: false, errorCode: 'reports_to_forbidden', details: { reason: 'input' } });
    expect(submittedAttachments).toEqual(['worker']);
  });

  it('proves an inactive archived child through continuation before treating its mutation as safe', async () => {
    const cursor = encodeV2SessionListCursorV2({ sessionId: 'archived-peer', meaningfulActivityAt: 10 });
    const executor = createTransportExecutor({
      sessionList: async ({ query }) => ({
        sessions: query?.storage === 'archived' && query.includeInactive && query.cursor === cursor
          ? [{ id: 'worker', active: false, presence: 'offline', updatedAt: 10 }] : [],
        nextCursor: query?.storage === 'archived' && query.cursor === undefined ? cursor : null,
        hasNext: query?.storage === 'archived' && query.cursor === undefined,
        queryVersion: 1, attentionNextCursor: null, attentionHasNext: false,
      }),
      sessionReportsToSet: async () => ({ ok: true, sessionId: 'worker', leadSessionId: 'lead', attachedAt: 1 }),
    });
    await expect(executor.execute('session.reports_to.set', input, {
      surface: 'agent', authority: 'account_automation', defaultSessionId: 'lead',
    })).resolves.toMatchObject({ ok: true });
  });

  it('requires explicit compare-and-set facts and preserves typed service failures', async () => {
    const spec = getActionSpec('session.reports_to.set');
    expect(spec.inputSchema.safeParse({ sessionId: 'worker', leadSessionId: 'lead' }).success).toBe(false);
    const sessionReportsToSet = vi.fn(async () => ({ ok: false as const, error: 'reports_to_forbidden' as const, reason: 'pairwise' as const }));
    const executor = createTransportExecutor({ sessionReportsToSet });
    await expect(executor.execute('session.reports_to.set', input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'reports_to_forbidden', details: { reason: 'pairwise' },
    });
    expect(sessionReportsToSet).toHaveBeenCalledWith(expect.objectContaining({ ...input, context, serverId: 'home' }));
  });

  it('refuses a response that belongs to a different attachment', async () => {
    const executor = createTransportExecutor({
      sessionReportsToSet: async () => ({ ok: true, sessionId: 'other-worker', leadSessionId: 'lead', attachedAt: 1 }),
    });
    await expect(executor.execute('session.reports_to.set', input, context)).resolves.toMatchObject({ ok: false });
  });
});
