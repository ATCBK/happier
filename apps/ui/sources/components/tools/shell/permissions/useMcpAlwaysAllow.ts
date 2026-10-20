import * as React from 'react';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { supportsSessionPermissionPersistence } from '@/sync/ops/sessionPermissionAnswers';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createRequestOwnedActionExecution } from '@/components/approvals/requestOwnedActionExecution';
import { createMcpAlwaysAllowController } from './mcpAlwaysAllow';

type McpAlwaysAllowController = ReturnType<typeof createMcpAlwaysAllowController>;
type McpAlwaysAllowWriters = { answerForSession(): Promise<void> };
/**
 * One Always allow per request: the attention tray and the transcript row both draw this footer, and the tray's
 * copy leaves as soon as the request is answered. The answer runs through the latest mounted view; the catalog
 * save is owned by the request (its Account's Home executor, like the enable request's Always), so it completes
 * after the card leaves and any view that remains shows "saved" or "Couldn't save · Try again".
 */
const sharedControllers = new Map<string, Readonly<{ controller: McpAlwaysAllowController; writers: { latest: McpAlwaysAllowWriters } }>>();

/** Mounted by the existing permission footer; its answer callback is answerThroughSession('allowForSession'). */
export function useMcpAlwaysAllow(input: Readonly<{
    requestId: string; turnId?: string; source?: string; identity: ResolvedMcpToolIdentityV1;
    scope: ServerAccountScope | null; canWriteCatalog: boolean; answerForSession(): Promise<void>;
}>) {
    const execution = useMountedActionExecution(input.scope);
    const key = JSON.stringify([input.scope?.serverId, input.scope?.accountId, execution.binding?.revision, input.requestId, input.turnId, input.source, input.identity.item.serverId, input.identity.tool]);
    const latest = React.useRef({ input, execution, key }); latest.current = { input, execution, key };
    const writers: McpAlwaysAllowWriters = {
        answerForSession: () => latest.current.key === key ? latest.current.input.answerForSession() : Promise.reject(new Error('scope-retired')),
    };
    const shared = React.useMemo(() => {
        const existing = sharedControllers.get(key);
        if (existing) return existing;
        const holder = { latest: writers };
        const created = { writers: holder, controller: createMcpAlwaysAllowController({ identity: input.identity,
            answerForSession: () => holder.latest.answerForSession(),
            execute: createRequestOwnedActionExecution(input.scope),
        }) };
        sharedControllers.set(key, created);
        return created;
    }, [key]);
    shared.writers.latest = writers;
    const controller = shared.controller;
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const available = input.canWriteCatalog && execution.ready && input.identity.server !== 'happier' && supportsSessionPermissionPersistence(input.source);
    const allow = React.useCallback(async () => {
        if (latest.current.key !== key || !latest.current.input.canWriteCatalog || !latest.current.execution.isCurrent()
            || latest.current.input.identity.server === 'happier' || !supportsSessionPermissionPersistence(latest.current.input.source)) return;
        await controller.allow();
    }, [controller, key]);
    return { ...state, available, allow, retrySave: allow };
}
