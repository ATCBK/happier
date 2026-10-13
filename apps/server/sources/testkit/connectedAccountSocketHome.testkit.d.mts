export type ConnectedAccountSocketHomeFixture = Readonly<{
    baseDir: string;
    baseUrl: string;
    accountId: string;
    machineId: string;
    token: string;
    installationId: string;
    keys: Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
    close(): Promise<void>;
}>;

/** Real authenticated Socket.IO and qualified storage routes over disposable SQLite. */
export function createConnectedAccountSocketHome(): Promise<ConnectedAccountSocketHomeFixture>;
