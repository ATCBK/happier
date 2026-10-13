/** A retired Action read no longer has custody of its captured Account's content. */
export function isActionAccountScopeChangedError(error: unknown): boolean {
    return error instanceof Error && (
        ('code' in error && error.code === 'action_account_scope_changed')
        // Domain errors retain transport refusals outside their closed domain vocabulary.
        || ('rawCode' in error && error.rawCode === 'action_account_scope_changed')
    );
}
