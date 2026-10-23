import * as React from 'react';
import type { Message, ToolCall } from "@happier-dev/session-core/messages";
import { normalizeToolCallForRendering } from '@happier-dev/session-core/tools';
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

// Approval bodies are immutable admitted snapshots. The reducer retains a ToolCall while replacing
// its input (toolCalls.ts / agentStatePermissions.ts), so tool identity alone is insufficient.
// These weak projections retain no superseded calls or requests and do no work on unchanged inputs.
// Baseline: 1,000 rows × 12 fallback requests serialized 24,000 inputs on each render.
const approvalInputs = new WeakMap<OpenApprovalArtifactForSession['approval'], string | null>();
const structuredToolInputs = new WeakMap<object, string | null>();
const primitiveToolInputs = new WeakMap<ToolCall, Readonly<{ input: unknown; value: string | null }>>();

function approvalInput(request: OpenApprovalArtifactForSession): string | null {
    const approval = request.approval;
    if (approvalInputs.has(approval)) return approvalInputs.get(approval)!;
    const origin = approval.origin;
    const expected = origin?.toolInput ?? (origin?.toolName === 'action_execute'
        ? { actionId: approval.actionId, input: approval.actionArgs } : approval.actionArgs);
    const value = stableSerialize(expected);
    approvalInputs.set(approval, value);
    return value;
}

function toolInput(tool: ToolCall): string | null {
    // Rendering normalization can project a new ToolCall for an output/name change while keeping
    // the same input. Key structured inputs directly, so the projection neither recomputes nor
    // retains a previous input after the reducer replaces it.
    if (tool.input !== null && typeof tool.input === 'object') {
        if (structuredToolInputs.has(tool.input)) return structuredToolInputs.get(tool.input)!;
        const value = stableSerialize(readHappierActionToolPayload(tool.input));
        structuredToolInputs.set(tool.input, value);
        return value;
    }
    const previous = primitiveToolInputs.get(tool);
    if (previous && previous.input === tool.input) return previous.value;
    const value = stableSerialize(readHappierActionToolPayload(tool.input));
    primitiveToolInputs.set(tool, { input: tool.input, value });
    return value;
}

type ToolApprovalMatch = Readonly<{
    sessionId: string | undefined;
    messageId: string | undefined;
    tool: ToolCall;
    normalizedToolName: string;
}>;
type Requests = readonly OpenApprovalArtifactForSession[];
const noRequests: Requests = Object.freeze([]);
type ApprovalIndex = Readonly<{
    byId: ReadonlyMap<string, OpenApprovalArtifactForSession>;
    buckets: ReadonlyMap<string, Requests>;
    fallbackNames: ReadonlySet<string>;
    fallbackSessions: ReadonlySet<string>;
    selections: Map<string, Requests>;
    order: ReadonlyMap<OpenApprovalArtifactForSession, number>;
}>;
const approvalIndexes = new WeakMap<Requests, ApprovalIndex>();
const keyPart = (value: string) => `${value.length}:${value}`;
const matchKey = (sessionId: string, kind: string, value: string) => `${keyPart(sessionId)}${kind}${keyPart(value)}`;
const sameRequests = (a: Requests | undefined, b: Requests) => a?.length === b.length && b.every((request, i) => a[i] === request);

/** One immutable association projection per transcript approval publication, shared by all its rows. */
function prepareToolApprovalRequests(requests: Requests, previous?: Requests): Requests {
    if (approvalIndexes.has(requests)) return requests;
    const prior = previous ? approvalIndexes.get(previous) : undefined;
    // The inventory reparses its bodies when one Artifact changes. Unchanged Artifact identities still
    // represent the same admitted request; normalize those rows here before projecting associations.
    const rows = requests.map(request => {
        const old = prior?.byId.get(request.artifact.id);
        return old?.artifact === request.artifact ? old : request;
    });
    const buckets = new Map<string, OpenApprovalArtifactForSession[]>();
    const fallbackNames = new Set<string>();
    const fallbackSessions = new Set<string>();
    const add = (key: string, request: OpenApprovalArtifactForSession) => {
        const bucket = buckets.get(key);
        if (bucket) { if (bucket[bucket.length - 1] !== request) bucket.push(request); }
        else buckets.set(key, [request]);
    };
    for (const request of rows) {
        const origin = request.approval.origin;
        if (origin?.kind !== 'transcript_tool_call') continue;
        for (const id of [origin.messageId, origin.parentMessageId]) if (id) add(matchKey(origin.sessionId, 'm', id), request);
        if (origin.toolCallId) add(matchKey(origin.sessionId, 't', origin.toolCallId), request);
        if (origin.messageId || origin.parentMessageId || origin.toolCallId || !origin.toolName) continue;
        const input = approvalInput(request);
        if (input === null) continue;
        const nameKey = matchKey(origin.sessionId, 'n', origin.toolName);
        fallbackNames.add(nameKey);
        fallbackSessions.add(origin.sessionId);
        add(`${nameKey}${keyPart(input)}`, request);
        add(matchKey(origin.sessionId, 'i', input), request);
    }
    const projectedBuckets = new Map<string, Requests>(buckets);
    for (const [key, bucket] of buckets) {
        const old = prior?.buckets.get(key);
        if (sameRequests(old, bucket)) projectedBuckets.set(key, old!);
    }
    const order = new Map(rows.map((request, i) => [request, i]));
    const selections = new Map<string, Requests>();
    // Keep only selections whose requests still belong to this publication; revoked/withdrawn rows
    // cannot survive in the projection. Each mounted transcript owns only its current associations.
    for (const [key, value] of prior?.selections ?? []) if (value.every(request => order.has(request))) selections.set(key, value);
    const result = sameRequests(previous, rows) ? previous! : rows;
    approvalIndexes.set(result, { byId: new Map(rows.map(request => [request.artifact.id, request])), buckets: projectedBuckets, fallbackNames, fallbackSessions, selections, order });
    // Raw arrays supplied by isolated tool/details surfaces use the same matcher, without a second path.
    approvalIndexes.set(requests, approvalIndexes.get(result)!);
    return result;
}

/** UI projection only: acquisition, approval policy and lifecycle remain with the existing owners. */
export function usePreparedToolApprovalRequests(requests: Requests): Requests {
    const previous = React.useRef<Requests | undefined>(undefined);
    return React.useMemo(() => {
        const next = prepareToolApprovalRequests(requests, previous.current);
        previous.current = next;
        return next;
    }, [requests]);
}

/** Exact associations first; fallback input is prepared once per changed ToolCall input. */
export function selectMatchingToolApprovalRequests(params: ToolApprovalMatch & Readonly<{ requests: Requests | undefined }>): Requests {
    if (!params.sessionId || !params.requests?.length) return noRequests;
    prepareToolApprovalRequests(params.requests);
    const index = approvalIndexes.get(params.requests)!;
    const keys: string[] = [];
    if (params.messageId) keys.push(matchKey(params.sessionId, 'm', params.messageId));
    if (typeof params.tool.id === 'string') keys.push(matchKey(params.sessionId, 't', params.tool.id));
    const names = new Set([params.tool.name, params.normalizedToolName,
        ...(params.tool.name.startsWith('mcp__happier__') ? [params.tool.name.slice('mcp__happier__'.length)] : [])]);
    const nameKeys = [...names].map(name => matchKey(params.sessionId!, 'n', name)).filter(key => index.fallbackNames.has(key));
    if (nameKeys.length) {
        const input = toolInput(params.tool);
        if (input !== null) for (const key of nameKeys) keys.push(`${key}${keyPart(input)}`);
    }
    const buckets = keys.flatMap(key => { const bucket = index.buckets.get(key); return bucket ? [bucket] : []; });
    if (!buckets.length) return noRequests;
    const matches = (request: OpenApprovalArtifactForSession) => doesApprovalMatchToolCall({ ...params, request });
    // The index supplies candidates; the canonical matcher still owns correlation policy.
    if (buckets.length === 1 && buckets[0]!.every(matches)) return buckets[0]!;
    const result = [...new Set(buckets.flat())].filter(matches).sort((a, b) => index.order.get(a)! - index.order.get(b)!);
    if (!result.length) return noRequests;
    const key = keys.map(keyPart).join('');
    const previous = index.selections.get(key);
    if (sameRequests(previous, result)) return previous!;
    index.selections.set(key, result);
    return result;
}

/** Narrow the list/turn/group's props before they reach memoized message and tool rows. */
export function selectToolApprovalRequestsForMessages(params: Readonly<{
    requests: Requests | undefined;
    sessionId: string;
    rowId: string;
    messages: readonly Message[];
    messageId?: string;
}>): Requests {
    if (!params.requests?.length) return noRequests;
    prepareToolApprovalRequests(params.requests);
    const index = approvalIndexes.get(params.requests)!;
    const selected = new Set<OpenApprovalArtifactForSession>();
    const visit = (message: Message) => {
        if (message.kind !== 'tool-call') return;
        const tool = normalizeToolCallForRendering(message.tool);
        // Tool chrome receives the canonical displayed route, which can differ from the reducer id.
        const displayedId = params.messageId ?? message.id;
        for (const messageId of new Set([message.id, displayedId])) {
            for (const request of selectMatchingToolApprovalRequests({ requests: params.requests, sessionId: params.sessionId,
                messageId, tool, normalizedToolName: tool.name })) selected.add(request);
        }
        // Header inference may name an old tool differently. This parent projection narrows by the
        // reviewed input only; the leaf still enforces its exact raw/normalized name through the matcher.
        if (index.fallbackSessions.has(params.sessionId)) {
            const input = toolInput(tool);
            if (input !== null) for (const request of index.buckets.get(matchKey(params.sessionId, 'i', input)) ?? []) selected.add(request);
        }
        for (const child of message.children) visit(child);
    };
    for (const message of params.messages) visit(message);
    if (!selected.size) return noRequests;
    const result = [...selected].sort((a, b) => index.order.get(a)! - index.order.get(b)!);
    const key = `g${keyPart(params.sessionId)}${keyPart(params.rowId)}`;
    const previous = index.selections.get(key);
    if (sameRequests(previous, result)) return previous!;
    index.selections.set(key, result);
    return result;
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
    const originInput = approvalInput(params.request);
    return originInput !== null && originInput === toolInput(params.tool);
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
    return readDeclinedApprovalAtCall(selectMatchingToolApprovalRequests({
        requests: params.requests,
        sessionId: params.sessionId,
        messageId: params.messageId,
        tool: params.tool,
        normalizedToolName: params.tool.name,
    }));
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
