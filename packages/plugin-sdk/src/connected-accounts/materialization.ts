/** Realm-neutral result of the host's admitted credential materialization. */
export type ConnectedAccountMaterialization = Readonly<{
    /** Scope positively established by this service from the credential revision materialized.
     * Omission or unknown never establishes personal usage eligibility. */
    usageAccountScope?: 'personal' | 'workspace' | 'unknown';
}> & (
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
    }>);
