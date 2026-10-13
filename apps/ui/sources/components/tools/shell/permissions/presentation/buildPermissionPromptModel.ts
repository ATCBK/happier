import type { ToolCall } from "@happier-dev/session-core/messages";
import type { Metadata } from '@happier-dev/session-core/state';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { resolveToolHeaderTextPresentation } from '@/components/tools/shell/presentation/resolveToolHeaderTextPresentation';

export type PermissionPromptModel = Readonly<{
    request: PendingPermissionRequest;
    tool: ToolCall & { permission: NonNullable<ToolCall['permission']> };
    headerText: ReturnType<typeof resolveToolHeaderTextPresentation>;
}>;

export function buildPermissionPromptModel(input: {
    request: PendingPermissionRequest;
    metadata: Metadata | null;
    nowMs: number;
}): PermissionPromptModel {
    const createdAt =
        typeof input.request.createdAt === 'number' && Number.isFinite(input.request.createdAt)
            ? input.request.createdAt
            : input.nowMs;

    const tool: PermissionPromptModel['tool'] = {
        id: `perm:${input.request.id}`,
        name: input.request.tool,
        state: 'running',
        input: input.request.arguments,
        createdAt,
        startedAt: createdAt,
        completedAt: null,
        description: null,
        result: null,
        permission: { id: input.request.id, status: 'pending',
            ...(input.request.turnId ? { turnId: input.request.turnId } : {}),
            ...(input.request.source ? { source: input.request.source } : {}),
            ...(input.request.permissionSuggestions !== undefined ? { suggestions: input.request.permissionSuggestions } : {}) },
    };

    const headerText = resolveToolHeaderTextPresentation({ tool, metadata: input.metadata });

    return { request: input.request, tool, headerText };
}
