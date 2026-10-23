type HomeSnapshotTables = {
    homeSettings: { findUnique(input: unknown): Promise<{ revision: number; values: unknown; encryptedSecrets: Uint8Array | null } | null> };
    homeGovernancePolicy: { findUnique(input: unknown): Promise<{ authenticationPolicy: unknown } | null> };
};

/** Persistence-boundary fixtures retain their existing rows/failure controls.
 * Real SQL semantics and operation costs are covered by the PostgreSQL contract.
 */
export const homeConfigSnapshotPostgresQueryMock = {
    async $queryRawUnsafe(this: HomeSnapshotTables, query: string, id: unknown) {
        if (!query.includes('FROM (SELECT 1) AS singleton') || !query.includes('LEFT JOIN "HomeGovernancePolicy"') || id !== 'home') {
            throw new Error('Unexpected Home snapshot fixture SQL');
        }
        const [settings, policy] = await Promise.all([
            this.homeSettings.findUnique({ where: { id }, select: { revision: true, values: true, encryptedSecrets: true } }),
            this.homeGovernancePolicy.findUnique({ where: { id }, select: { authenticationPolicy: true } }),
        ]);
        return [{ revision: settings?.revision ?? null, values: settings?.values ?? null,
            encryptedSecrets: settings?.encryptedSecrets ?? null, authenticationPolicy: policy?.authenticationPolicy ?? null }];
    },
};
