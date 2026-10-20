export async function forwardCodeIntelligenceSettlements(paths: readonly string[], input: Readonly<{
    acceptsExternalChanges(): boolean;
    syncExternal(paths: readonly string[]): Promise<void>;
}>): Promise<void> {
    if (input.acceptsExternalChanges()) await input.syncExternal(paths);
}
