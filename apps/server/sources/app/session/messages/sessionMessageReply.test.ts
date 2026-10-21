import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { createDbMocks, createDbTransactionMock, inTxPostgresControlStatementMock, installDbModuleMock,
    matchesDbMockWhere } from '@/app/api/testkit/dbMocks';

const boundary = createDbMocks({ sessionMessage: ['findMany', 'findUnique', 'findFirst', 'updateMany'],
    sessionPendingMessage: ['findMany', 'findUnique'], session: ['findUnique'] });
const transactions = createDbTransactionMock(() => ({ ...boundary.db, ...inTxPostgresControlStatementMock }));
// Only Prisma's persistent connection is replaced; custody, strict parsing,
// transaction context, final selection and replay decisions remain production code.
installDbModuleMock({ db: transactions.wrapDb(boundary.db) });
const { inTx } = await import('@/storage/inTx');
const { projectSessionInputRepliesFromTurnInTx } = await import('./sessionMessageReply');

beforeEach(() => { boundary.reset(); vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres'); });
afterEach(() => vi.unstubAllEnvs());

it.each(['partial', 'empty', 'explicit'] as const)('retains the exact cancelled foreground outcome through replay (%s)', async kind => {
    const progress: SessionMessageReplyProgressV1 = { v: 1, mode: 'wait', acceptedTurnId: 'stopped-turn', disposition: 'observing',
        ...(kind === 'explicit' ? { outcome: { kind: 'pass' } } : {}) };
    const input = { id: 'input-row', sessionId: 'session', seq: 1, localId: 'input', messageRole: 'user', sidechainId: null,
        targetExecutionRunId: null, replyDisposition: 'observing', inputAdmissionReceipt: null, replyProgress: progress };
    const foreign: typeof input = { ...input, id: 'foreign-input', seq: 4, localId: 'foreign',
        replyProgress: { ...progress, acceptedTurnId: 'another-turn' } };
    const final = { id: 'stopped-partial', sessionId: 'session', seq: 2, localId: 'partial', messageRole: 'agent', sidechainId: null };
    const rows = [input, foreign, final, { ...final, id: 'unrelated-later', seq: 5 }];
    boundary.db.session.findUnique.mockResolvedValue(null);
    boundary.db.sessionPendingMessage.findUnique.mockResolvedValue(null);
    boundary.db.sessionPendingMessage.findMany.mockResolvedValue([]);
    boundary.db.sessionMessage.findMany.mockImplementation(async ({ where }: { where: unknown }) => rows.filter(row => matchesDbMockWhere(row, where)));
    boundary.db.sessionMessage.findFirst.mockImplementation(async ({ where }: { where: unknown }) => rows.find(row => matchesDbMockWhere(row, where)) ?? null);
    boundary.db.sessionMessage.findUnique.mockImplementation(async ({ where }: { where: { sessionId_localId: unknown } }) =>
        rows.find(row => matchesDbMockWhere(row, where.sessionId_localId)) ?? null);
    boundary.db.sessionMessage.updateMany.mockImplementation(async ({ where, data }: { where: unknown; data: { replyProgress: SessionMessageReplyProgressV1 } }) => {
        const row = [input, foreign].find(row => matchesDbMockWhere(row, where));
        if (!row) return { count: 0 };
        row.replyProgress = data.replyProgress;
        return { count: 1 };
    });
    const stopped = { sessionId: 'session', turnId: 'stopped-turn', status: 'cancelled',
        transcriptAnchorsJson: JSON.stringify({ userMessageSeqs: [1, 4], ...(kind !== 'empty' ? { finalAssistantMessageSeq: 2 } : {}) }) };
    await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, stopped));
    await inTx(tx => projectSessionInputRepliesFromTurnInTx(tx, stopped));
    expect(input.replyProgress.outcome).toEqual(kind === 'explicit' ? { kind: 'pass' } : kind === 'empty' ? { kind: 'cancelled' }
        : { kind: 'cancelled', result: { sessionId: 'session', messageId: 'stopped-partial' } });
    expect(foreign.replyProgress).toEqual({ ...progress, acceptedTurnId: 'another-turn' });
    expect(JSON.stringify(input.replyProgress)).not.toContain('partialText');
});
