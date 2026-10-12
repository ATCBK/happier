import type { DiagnosticsActionId, DiagnosticsActionResult } from '@happier-dev/protocol/actions/diagnosticsActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ServerFetch } from '@/sync/http/client';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type DiagnosticInvocation = Readonly<{
    context: Pick<ActionExecutorContext, 'serverId' | 'runtimeAccountId' | 'signal'>;
    request: ServerFetch;
    assertCurrent(): void;
}>;
type MountedDiagnosticOwner = Readonly<{
    scope: ServerAccountScope;
    isCurrent(): boolean;
    run(invocation: DiagnosticInvocation): Promise<DiagnosticsActionResult>;
}>;

// Only an answering-client address: the mounted page retains its operation and state.
const mountedOwners = new Map<DiagnosticsActionId, MountedDiagnosticOwner>();
export function registerMountedDiagnosticOwner(actionId: DiagnosticsActionId, owner: MountedDiagnosticOwner): () => void {
    mountedOwners.set(actionId, owner);
    return () => { if (mountedOwners.get(actionId) === owner) mountedOwners.delete(actionId); };
}
export async function invokeDiagnosticAction(actionId: DiagnosticsActionId, invocation: DiagnosticInvocation): Promise<DiagnosticsActionResult> {
    invocation.assertCurrent();
    const owner = mountedOwners.get(actionId);
    const { serverId, runtimeAccountId: accountId } = invocation.context;
    if (!owner || !serverId || !accountId || !owner.isCurrent()
        || !areServerAccountScopesEqual(owner.scope, { serverId, accountId })) return { status: 'unavailable' };
    const assertCurrent = () => {
        invocation.assertCurrent();
        if (mountedOwners.get(actionId) !== owner || !owner.isCurrent()) {
            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
        }
    };
    const result = await owner.run({ ...invocation, assertCurrent });
    assertCurrent();
    return result;
}
