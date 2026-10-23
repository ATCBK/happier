import type { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

/** A retired Action read no longer has custody of its captured Account's content. */
export function isActionAccountScopeChangedError(error: unknown): boolean {
    return error instanceof Error && (
        ('code' in error && error.code === 'action_account_scope_changed')
        // Domain errors retain transport refusals outside their closed domain vocabulary.
        || ('rawCode' in error && error.rawCode === 'action_account_scope_changed')
    );
}
/** Captured Account writes retain effect truth after their disclosure scope retires. */
export function isActionEffectResult(effectClass: ReturnType<typeof getActionSpec>['sideEffectClass'] | undefined): boolean {
    return effectClass === 'write' || effectClass === 'external' || effectClass === 'danger';
}

