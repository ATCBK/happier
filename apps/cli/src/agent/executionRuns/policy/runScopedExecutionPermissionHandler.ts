import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { ExecutionRunPermissionInteractionMode } from './executionRunPermissionInteractionPolicy';
import { createExecutionRunPermissionHandler } from './executionRunPermissionDecision';
import { parseMcpToolWireNameV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import type { AcpPermissionCallContext } from '@/agent/acp/permissions/acpPermissionHandler';

function requestIdPrefix(runId: string): string {
  return `execution-run:${encodeURIComponent(runId)}:`;
}

function occurrenceRequestIdPrefix(runId: string, controllerOccurrenceId: string): string {
  return `${requestIdPrefix(runId)}${encodeURIComponent(controllerOccurrenceId)}:`;
}

export function buildRunScopedExecutionPermissionRequestId(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  providerRequestId: string;
}>): string {
  const runId = String(params.runId ?? '').trim();
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  if (!runId || !controllerOccurrenceId) {
    throw new Error('Execution-run permission request identity requires run and controller occurrence ids');
  }
  return `${occurrenceRequestIdPrefix(runId, controllerOccurrenceId)}${encodeURIComponent(params.providerRequestId)}`;
}

export function readRunScopedExecutionProviderRequestId(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  requestId: string;
}>): string | null {
  const runId = String(params.runId ?? '').trim();
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  if (!controllerOccurrenceId) return null;
  const prefix = occurrenceRequestIdPrefix(runId, controllerOccurrenceId);
  if (!runId || !params.requestId.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(params.requestId.slice(prefix.length));
  } catch {
    return null;
  }
}

export function createRunScopedExecutionPermissionHandler(params: Readonly<{
  runId: string;
  controllerOccurrenceId: string;
  handler: AcpPermissionHandler;
  toolPolicy?: Omit<Parameters<typeof createExecutionRunPermissionHandler>[0], 'publishPendingRequest'>;
  mcpToolPolicy?: NonNullable<AcpPermissionCallContext['mcpToolPolicy']>;
  onPendingRequestAborted?: (request: Readonly<{
    requestId: string;
    reason: string;
  }>) => void | Promise<void>;
  readInteractionMode?: () => ExecutionRunPermissionInteractionMode;
}>): Readonly<{
  handler: AcpPermissionHandler;
  respondToPermissionRequest: (providerRequestId: string, approved: boolean) => boolean;
  dispose: (reason: string) => Promise<void>;
}> {
  const runId = String(params.runId ?? '').trim();
  if (!runId) throw new Error('Execution-run permission scope requires a non-blank runId');
  const controllerOccurrenceId = String(params.controllerOccurrenceId ?? '').trim();
  if (!controllerOccurrenceId) throw new Error('Execution-run permission scope requires a controller occurrence id');
  const abortPendingRequestAndFlush = params.handler.abortPendingRequestAndFlush;
  if (typeof abortPendingRequestAndFlush !== 'function') {
    throw new Error('Execution-run permission scope requires exact permission cancellation support');
  }
  const pendingRequestIds = new Set<string>();
  const toolPolicy = params.toolPolicy ? createExecutionRunPermissionHandler(params.toolPolicy) : null;
  const cleanupRequestIds = new Set<string>();
  const abortingRequestIds = new Set<string>();
  const scopedRequestId = (requestId: string) => buildRunScopedExecutionPermissionRequestId({
    runId,
    controllerOccurrenceId,
    providerRequestId: requestId,
  });
  const mcpContext = (toolName: string, context: AcpPermissionCallContext | undefined): AcpPermissionCallContext | undefined => {
    const policy = params.mcpToolPolicy ?? (params.toolPolicy?.getMcpToolContext
      ? { permissionMode: params.toolPolicy.permissionMode, readContext: params.toolPolicy.getMcpToolContext } : undefined);
    const current = policy?.readContext();
    return policy && current && parseMcpToolWireNameV1(toolName, new Set(Object.keys(current.mcpServerIdentities)))
      ? { ...context, mcpToolPolicy: policy } : context;
  };
  const readImmediate: NonNullable<AcpPermissionHandler['getImmediateDecision']> = (toolCallId, toolName, input, context) => {
    const inherited = params.handler.getImmediateDecision?.(toolCallId, toolName, input, mcpContext(toolName, context)) ?? null;
    if (inherited?.decision === 'denied' || inherited?.decision === 'abort') return inherited;
    return toolPolicy?.getImmediateDecision(toolCallId, toolName, input, context) ?? inherited;
  };

  const abortExact = async (requestId: string, reason: string): Promise<void> => {
    if (!pendingRequestIds.has(requestId) && !cleanupRequestIds.has(requestId)) return;
    cleanupRequestIds.add(requestId);
    abortingRequestIds.add(requestId);
    try {
      await abortPendingRequestAndFlush.call(params.handler, requestId, reason);
      await params.onPendingRequestAborted?.({ requestId, reason });
      pendingRequestIds.delete(requestId);
      cleanupRequestIds.delete(requestId);
    } finally {
      abortingRequestIds.delete(requestId);
    }
  };

  return {
    handler: {
      ...(params.handler.resolvePrePromptDecision
        ? {
            resolvePrePromptDecision: async (toolCallId, toolName, input) =>
              readImmediate(scopedRequestId(toolCallId), toolName, input)
              ?? await params.handler.resolvePrePromptDecision!(scopedRequestId(toolCallId), toolName, input),
          }
        : {}),
      ...(params.handler.getImmediateDecision || params.toolPolicy
        ? {
            getImmediateDecision: (toolCallId, toolName, input, context) =>
              readImmediate(scopedRequestId(toolCallId), toolName, input, context),
          }
        : {}),
      async handleToolCall(toolCallId, toolName, input, context) {
        const requestId = scopedRequestId(toolCallId);
        const immediate = readImmediate(requestId, toolName, input, context);
        if (immediate) return immediate;
        const interactionMode = params.readInteractionMode?.();
        if (interactionMode === 'deterministic' || interactionMode === 'fail_closed') {
          return { decision: 'denied' };
        }
        if (interactionMode === 'interaction_unavailable') {
          throw Object.assign(
            new Error('Execution-run permission interaction target is unavailable'),
            { code: 'execution_run_interaction_unavailable' },
          );
        }
        pendingRequestIds.add(requestId);
        try {
          return await params.handler.handleToolCall(requestId, toolName, input, mcpContext(toolName, context));
        } finally {
          if (!abortingRequestIds.has(requestId)) pendingRequestIds.delete(requestId);
        }
      },
      async abortPendingRequestAndFlush(toolCallId, reason) {
        await abortExact(scopedRequestId(toolCallId), reason);
      },
      async abortPendingRequestsAndFlush(reason) {
        await Promise.all([...new Set([...pendingRequestIds, ...cleanupRequestIds])].map(async (requestId) => {
          await abortExact(requestId, reason);
        }));
      },
    },
    respondToPermissionRequest(providerRequestId, approved) {
      const requestId = scopedRequestId(providerRequestId);
      if (!pendingRequestIds.has(requestId)) return false;
      const responder = (params.handler as AcpPermissionHandler & Readonly<{
        respondToPermissionRequest?: (requestId: string, approved: boolean) => boolean;
      }>).respondToPermissionRequest;
      if (!responder) return false;
      return responder(requestId, approved);
    },
    async dispose(reason) {
      await Promise.all([...new Set([...pendingRequestIds, ...cleanupRequestIds])].map(async (requestId) => {
        await abortExact(requestId, reason);
      }));
    },
  };
}
