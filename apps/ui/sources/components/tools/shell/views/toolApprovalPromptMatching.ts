import type { ToolCall } from "@happier-dev/session-core/messages";
import { readHappierActionToolPayload } from '@happier-dev/protocol/actions/happierActionToolResult';
import type { OpenApprovalArtifactForSession } from '@/sync/domains/artifacts/approvalArtifacts';
import type { DeclinedApprovalDisposition } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { PermissionToolCallMessageLocation } from '@/utils/sessions/permissions/permissionToolCallLocationTypes';

function stableSerialize(value: unknown): string | null {
    if (typeof value === 'undefined') return null;
    try {
        return JSON.stringify(value, (_key, nested) => {
            if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(nested).sort()) sorted[key] = (nested as Record<string, unknown>)[key];
            return sorted;
        });
    } catch {
        return null;
    }
}

export function doesApprovalMatchToolCall(params: Readonly<{
    request: OpenApprovalArtifactForSession;
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
    normalizedToolName: string;
}>): boolean {
    const origin = params.request.approval.origin;
    if (origin?.kind !== 'transcript_tool_call') return false;
    if (!params.sessionId || origin.sessionId !== params.sessionId) return false;
    if (origin.messageId || origin.parentMessageId) {
        if (params.messageId && (origin.messageId === params.messageId || origin.parentMessageId === params.messageId)) {
            return true;
        }
        if (origin.toolCallId) {
            return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
        }
        return false;
    }
    if (origin.toolCallId) {
        return typeof params.tool.id === 'string' && origin.toolCallId === params.tool.id;
    }
    if (!origin.toolName || (origin.toolName !== params.tool.name
        && `mcp__happier__${origin.toolName}` !== params.tool.name
        && origin.toolName !== params.normalizedToolName)) return false;
    // Clients without native correlation can only match the exact reviewed
    // input. Reuse the stored Action operands; never persist another raw input
    // copy or fall back to a tool name alone (notably action_execute).
    const expectedInput = origin.toolInput ?? (origin.toolName === 'action_execute'
        ? { actionId: params.request.approval.actionId, input: params.request.approval.actionArgs }
        : params.request.approval.actionArgs);
    const originInput = stableSerialize(expectedInput);
    return originInput !== null && originInput === stableSerialize(readHappierActionToolPayload(params.tool.input));
}

/** A declined request (rejected or canceled) at this call: its card says what was asked and that the person said no. */
export function readDeclinedApprovalAtCall(requests: readonly OpenApprovalArtifactForSession[]): DeclinedApprovalDisposition | null {
    for (const { approval } of requests) {
        if (approval.status === 'rejected' || approval.status === 'canceled') return approval.status;
    }
    return null;
}

/** The declined disposition of the approvals that belong to one transcript call, for surfaces that show no card. */
export function readDeclinedApprovalAtToolCall(params: Readonly<{
    requests: readonly OpenApprovalArtifactForSession[] | undefined;
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
}>): DeclinedApprovalDisposition | null {
    if (!params.requests || params.requests.length === 0) return null;
    return readDeclinedApprovalAtCall(params.requests.filter((request) => doesApprovalMatchToolCall({
        request,
        sessionId: params.sessionId,
        messageId: params.messageId,
        tool: params.tool,
        normalizedToolName: params.tool.name,
    })));
}

/** The call's raw output as text, for the Technical details of the declined card that replaces it in the row. */
export function readToolOutputText(tool: ToolCall): string | null {
    const result = tool.result;
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result.trim() || null;
    try {
        return JSON.stringify(result, null, 2) ?? null;
    } catch {
        return null;
    }
}

export function buildApprovalToolCallLocation(params: Readonly<{
    messageId: string | undefined;
}>): PermissionToolCallMessageLocation | null {
    if (!params.messageId) return null;
    return { kind: 'top', messageId: params.messageId, seq: null };
}
