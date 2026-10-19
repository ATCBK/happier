import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import type { Account, Machine } from '@prisma/client';

type PersistedAdmissionMachineRow = Pick<Machine,
    'id' | 'kind' | 'accountId' | 'installationId' | 'active' | 'revokedAt' | 'replacedByMachineId'
    | 'metadata' | 'metadataVersion' | 'daemonState' | 'daemonStateVersion' | 'dataEncryptionKey'
> & {
    account: Pick<Account, 'status' | 'encryptionMode'>;
    accountGrants: never[];
    teamGrants: never[];
    groupGrants: never[];
};

/** Persistence fixture only: the real Machine admission owner evaluates these rows. */
export const TEST_MACHINE_INSTALLATION_ID = 'test-machine-installation';

export function createMachineAdmissionPersistenceBoundary(custodian: string | (() => string)) {
    let readAvailability = async (_machineId: string): Promise<'available' | 'revoked' | 'replaced' | 'missing'> => 'available';
    const persistence = {
        // Transaction-local settings are database commands, not admission decisions.
        $executeRaw: async (_query: TemplateStringsArray, ..._values: unknown[]): Promise<number> => 0,
        $queryRaw: async (query: TemplateStringsArray) => {
            if (query.join('') === 'SHOW statement_timeout') return [{ statement_timeout: '0' }];
            throw new Error('Unexpected Machine-admission database query');
        },
        $executeRawUnsafe: async (query: string): Promise<number> => {
            if (/^SET LOCAL statement_timeout = \d+$/.test(query)) return 0;
            throw new Error('Unexpected Machine-admission database command');
        },
        machine: {
            findMany: async ({ where }: { where: { id: { in: readonly string[] } } }): Promise<PersistedAdmissionMachineRow[]> => {
                const rows = await Promise.all(where.id.in.map(id => persistence.machine.findUnique({ where: { id } })));
                return rows.filter(row => row !== null);
            },
            findUnique: async ({ where }: { where: { id: string } }) => {
                const availability = await readAvailability(where.id);
                if (availability === 'missing') return null;
                const accountId = typeof custodian === 'string' ? custodian : custodian();
                return {
                    id: where.id, kind: 'persistent', accountId, installationId: TEST_MACHINE_INSTALLATION_ID,
                    active: true, revokedAt: availability === 'revoked' ? new Date(1) : null,
                    replacedByMachineId: availability === 'replaced' ? 'replacement-machine' : null,
                    metadata: encodePlainMachineStoredContent({ host: 'test-host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }), metadataVersion: 1,
                    daemonState: null, daemonStateVersion: 0, dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                    account: { status: 'active', encryptionMode: 'plain' }, accountGrants: [], teamGrants: [], groupGrants: [],
                } satisfies PersistedAdmissionMachineRow;
            },
        },
    };
    return {
        db: { ...persistence, $transaction: <T>(work: (tx: typeof persistence) => Promise<T>) => work(persistence) },
        setAvailabilityReader: (reader: typeof readAvailability) => { readAvailability = reader; },
        reset: () => { readAvailability = async () => 'available'; },
    };
}
