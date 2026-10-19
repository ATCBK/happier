import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { inTxPostgresControlStatementMock } from './dbMocks';

/** Database I/O boundary for the real Home issuer and installed-Session MCP journey. */
export function createInstalledSessionExternalActionStorage() {
    const publicKey: Uint8Array = new Uint8Array();
    const state = {
        accountId: 'account', machineId: 'machine', sessionId: 'session', installationId: 'installation',
        homeId: 'srv_proposal_admission', bound: true, publisherBound: true,
        publicKey, metadata: encodePlainMachineStoredContent({}),
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null as Date | null,
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
    const reader = {
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
            findFirst: async ({ where }: { where: { id: string; accountId?: string } }) => state.bound
                && where.id === state.sessionId && (where.accountId === undefined || where.accountId === state.accountId)
                ? { id: state.sessionId, accountId: state.accountId } : null,
            findUnique: async ({ where }: { where: { id: string } }) => state.bound && where.id === state.sessionId
                ? { id: state.sessionId, accountId: state.accountId } : null,
        },
        accessKey: { findUnique: async ({ where }: { where: { accountId_machineId_sessionId: { accountId: string; machineId: string; sessionId: string } } }) => {
            const key = where.accountId_machineId_sessionId;
            return state.bound && key.accountId === state.accountId && key.machineId === state.machineId && key.sessionId === state.sessionId
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
