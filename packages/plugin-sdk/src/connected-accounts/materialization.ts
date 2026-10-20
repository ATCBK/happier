/** Realm-neutral result of the host's admitted credential materialization. */
export type ConnectedAccountMaterialization =
    | Readonly<{
        kind: 'httpHeaders';
        headers: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'environment';
        env: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'files';
        files: Readonly<Record<string, Uint8Array>>;
    }>;
