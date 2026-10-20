export type ConnectedAccountSocketHomeFixture = Readonly<{
    baseDir: string;
    baseUrl: string;
    accountId: string;
    machineId: string;
    token: string;
    installationId: string;
    keys: Readonly<{ publicKey: Uint8Array; secretKey: Uint8Array }>;
    encryptionMode: 'plain' | 'e2ee';
    machineEncryptionKey: Uint8Array | null;
    encryption: Readonly<{ type: 'dataKey'; machineKey: Uint8Array; publicKey: Uint8Array }> | null;
    close(): Promise<void>;
}>;

/** Real authenticated Socket.IO and qualified storage routes over disposable SQLite. */
export function createConnectedAccountSocketHome(options?: Readonly<{ encryptionMode?: 'plain' | 'e2ee' }>): Promise<ConnectedAccountSocketHomeFixture>;
