import * as React from 'react';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { supportsSessionPermissionPersistence } from '@/sync/ops/sessionPermissionAnswers';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createMcpAlwaysAllowController } from './mcpAlwaysAllow';

/** Mounted by the existing permission footer; its answer callback is answerThroughSession('allowForSession'). */
export function useMcpAlwaysAllow(input: Readonly<{
    requestId: string; turnId?: string; source?: string; identity: ResolvedMcpToolIdentityV1;
    scope: ServerAccountScope | null; canWriteCatalog: boolean; answerForSession(): Promise<void>;
}>) {
    const execution = useMountedActionExecution(input.scope);
    const key = JSON.stringify([input.scope?.serverId, input.scope?.accountId, execution.binding?.revision, input.requestId, input.turnId, input.source, input.identity.item.serverId, input.identity.tool]);
    const latest = React.useRef({ input, execution, key }); latest.current = { input, execution, key };
    const controller = React.useMemo(() => createMcpAlwaysAllowController({ identity: input.identity,
        answerForSession: () => latest.current.key === key ? latest.current.input.answerForSession() : Promise.reject(new Error('scope-retired')),
        // An answer may settle after this hook selects another Account. Keep the
        // original mounted Action's lifetime; never retarget its pending save.
        execute: (id, operands) => execution.execute(id, operands),
    }), [key]);
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const available = input.canWriteCatalog && execution.ready && input.identity.server !== 'happier' && supportsSessionPermissionPersistence(input.source);
    const allow = React.useCallback(async () => {
        if (latest.current.key !== key || !latest.current.input.canWriteCatalog || !latest.current.execution.isCurrent()
            || latest.current.input.identity.server === 'happier' || !supportsSessionPermissionPersistence(latest.current.input.source)) return;
        await controller.allow();
    }, [controller, key]);
    return { ...state, available, allow, retrySave: allow };
}
