import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { homeConfigSnapshotPostgresQueryMock } from '../../home/settings/homeConfigSnapshot.testkit';
import { createDbMocks, inTxPostgresControlStatementMock, matchesDbMockWhere } from './dbMocks';

/** Database I/O boundary for the real Home issuer and installed-Session MCP journey. */
export function createInstalledSessionExternalActionStorage() {
    const publicKey: Uint8Array = new Uint8Array();
    const state = {
        accountId: 'account', machineId: 'machine', sessionId: 'session', installationId: 'installation',
        homeId: 'srv_proposal_admission', bound: true, publisherBound: true,
        publicKey, metadata: encodePlainMachineStoredContent({}),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null as Date | null,
        sessionIds: new Set<string>(), directReportSessionIds: new Set<string>(),
        sessionAccessKeyIds: new Set<string>(),
    };
    const account = { id: state.accountId, status: 'active', tokenEpoch: 1,
        encryptionMode: 'plain', terminalPresentUserPolicy: 'never' };
    const otherAccount = { ...account, id: 'other-account' };
    const machine = () => ({ id: state.machineId, accountId: state.accountId, kind: 'persistent',
        installationId: state.installationId, installationPublicKey: state.publicKey,
        revokedAt: state.revokedAt, replacedByMachineId: null, active: true,
        metadata: state.metadata, daemonState: null, dataEncryptionKey: state.dataEncryptionKey,
        account, accountGrants: [], teamGrants: [], groupGrants: [] });
    type MachineWhere = { id?: string; accountId?: string; installationId?: string; revokedAt?: null; replacedByMachineId?: null };
    const readMachine = async ({ where }: { where: MachineWhere }) => {
        const row = machine();
        return Object.entries(where).every(([field, expected]) => row[field as keyof typeof row] === expected) ? row : null;
    };
    // All Session rows in this boundary fixture belong to its active Account.
    // The real subtree reader still traverses these stored direct edges.
    const sessionFields = createDbMocks({ session: [] }).db.session.fields;
    const readSession = (id: string) => state.bound && (id === state.sessionId || state.sessionIds.has(id))
        ? { id, accountId: state.accountId, account } : null;
    const readSessions = () => [...new Set([state.sessionId, ...state.sessionIds])].flatMap(id => {
        const row = readSession(id);
        return row ? [row] : [];
    });
    const reader = {
        ...homeConfigSnapshotPostgresQueryMock,
        // The real transaction owner now establishes a PostgreSQL read snapshot.
        // Replace only that database command, leaving currentness/policy real.
        ...inTxPostgresControlStatementMock,
        account: { findUnique: async ({ where }: { where: { id: string } }) =>
            where.id === account.id ? account : where.id === otherAccount.id ? otherAccount : null },
        machine: { findUnique: readMachine, findFirst: readMachine,
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.includes(state.machineId) ? [machine()] : [],
        },
        session: {
            fields: sessionFields,
            findFirst: async ({ where }: { where: unknown }) => readSessions().find(row => matchesDbMockWhere(row, where)) ?? null,
            findUnique: async ({ where }: { where: { id: string } }) => readSession(where.id),
            findMany: async ({ where }: { where: unknown }) => readSessions().filter(row => matchesDbMockWhere(row, where)),
        },
        sessionFollowEdge: { findMany: async ({ where }: { where: { relation: string; destinationSessionId: { in: string[] } } }) =>
            where.relation === 'manager' && where.destinationSessionId.in.includes(state.sessionId)
                ? [...state.directReportSessionIds].map(sourceSessionId => ({ sourceSessionId })) : [],
        },
        teamMembership: { findMany: async () => [] },
        accessKey: { findUnique: async ({ where }: { where: { accountId_machineId_sessionId: { accountId: string; machineId: string; sessionId: string } } }) => {
            const key = where.accountId_machineId_sessionId;
            return state.bound && key.accountId === state.accountId && key.machineId === state.machineId
                && (key.sessionId === state.sessionId || state.sessionAccessKeyIds.has(key.sessionId))
                ? { machine: machine(), session: { accountId: state.accountId } } : null;
        } },
        simpleCache: { findUnique: async () => ({ value: state.homeId }) },
        homeSettings: { findUnique: async () => null },
        homeGovernancePolicy: { findUnique: async () => null },
    };
    const db = { ...reader, $transaction: async <T>(run: (tx: typeof reader) => Promise<T>) => run(reader) };
    return { db, state, account, otherAccount };
}

export const installedSessionExternalActionStorage = createInstalledSessionExternalActionStorage();
