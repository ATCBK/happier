import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type {
  AcpPermissionCallContext,
  AcpPermissionCausalAuthority,
} from '@/agent/acp/permissions/acpPermissionHandler';
import {
  isPermissionGuardToolName,
  isSharedPermissionSafeToolName,
  isSharedPermissionWriteLikeToolName,
} from '@/agent/permissions/permissionTaxonomy';
import { resolveCausalPermissionMode } from '@/agent/permissions/causalPermissionMode';
import type { PermissionMode } from '@/api/types';
import { resolveProviderPermissionForHappierAction } from '@/agent/tools/happierTools/resolveHappierActionForMcpToolName';
import { extractShellCommand } from '@happier-dev/protocol/activity/shellCommand';
import { isWorkspaceWriteDeniedByRole } from '@/agent/permissions/workspaceWritePolicy';
import { applyAllowedToolsToAllowlist } from '@/agent/permissions/applyPermissionAllowlistUpdates';
import { isToolAllowedForSession } from '@/agent/permissions/permissionToolIdentifier';
import type { AgentSessionConfigurationSnapshotV1 } from '@happier-dev/protocol/runtime/agentSessionV1';

import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';
import { prepareMcpToolCatalog, resolveMcpToolIdentity, type McpToolPolicyContext } from '@/mcp/runtime/resolveMcpToolIdentity';
import { parseAgentPermissionIntentV1Alias } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { SessionInputCausalPermissionAuthorityV1Schema, type SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

/** Admission for a fresh Run input; an earlier turn never supplies its authority. */
export function resolveExecutionRunInputAuthority(input: Readonly<{
  permissionMode: string;
  causalPermissionAuthority?: unknown;
  effectiveCallerPermissionMode?: string;
}>): Readonly<{
  ok: true;
  causalPermissionAuthority: SessionInputCausalPermissionAuthorityV1;
  effectiveCallerPermissionMode: PermissionMode;
}> | Readonly<{ ok: false; errorCode: 'execution_run_not_allowed'; error: string }> {
  const failure = { ok: false as const, errorCode: 'execution_run_not_allowed' as const,
    error: 'causal_permission_authority_invalid' };
  const hasAuthority = Object.hasOwn(input, 'causalPermissionAuthority');
  // A private caller mode proves that this input must carry its original witness.
  if (!hasAuthority && input.effectiveCallerPermissionMode !== undefined) return failure;
  const parsed = SessionInputCausalPermissionAuthorityV1Schema.safeParse(hasAuthority
    ? input.causalPermissionAuthority
    : { kind: 'admittedSessionInputV1', admittedPermissionCeiling: permissionMode(input.permissionMode) });
  if (!parsed.success) return failure;
  const resolved = resolveCausalPermissionMode({ currentPermissionMode: permissionMode(input.permissionMode),
    context: { causalPermissionAuthority: parsed.data,
      ...(input.effectiveCallerPermissionMode !== undefined ? { callerPermissionMode: input.effectiveCallerPermissionMode } : {}) },
  });
  return resolved.ok
    ? { ok: true, causalPermissionAuthority: parsed.data, effectiveCallerPermissionMode: resolved.effectiveMode }
    : failure;
}

const EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS = new Set([
  'git status',
  'git diff',
  'git log',
  'git branch --show-current',
  'git rev-parse --show-toplevel',
]);

export type ExecutionRunPermissionHandler = AcpPermissionHandler & Readonly<{
  getImmediateDecision: NonNullable<AcpPermissionHandler['getImmediateDecision']>;
  respondToPermissionRequest: (toolCallId: string, approved: boolean) => boolean;
}>;

export function isExecutionRunWriteLikeToolName(toolName: string): boolean {
  const lower = String(toolName ?? '').trim().toLowerCase();
  if (!lower) return true;
  if (isPermissionGuardToolName(lower)) return true;
  return isSharedPermissionWriteLikeToolName(lower);
}

export function shouldAlwaysApproveExecutionRunTool(toolName: string): boolean {
  return isSharedPermissionSafeToolName(toolName);
}

function resolveExecutionRunImmediateDecision(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  context?: AcpPermissionCallContext;
  getMcpToolContext?: () => McpToolPolicyContext | null;
}>): { decision: 'approved' | 'approved_for_session' | 'denied' } | null {
  const rawLower = String(args.permissionMode ?? '').trim().toLowerCase();
  const normalizedMode = permissionMode(args.permissionMode);
  const hasContextCausalAuthority = Boolean(
    args.context
    && Object.prototype.hasOwnProperty.call(args.context, 'causalPermissionAuthority'),
  );
  const hasRunCausalAuthority = Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority');
  const effective = resolveCausalPermissionMode({
    currentPermissionMode: normalizedMode,
    context: hasContextCausalAuthority
      ? args.context
      : hasRunCausalAuthority
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : undefined,
  });

  // A supplied causal authority that cannot be proved valid is itself a typed
  // non-authorizing fact. Returning a pending prompt here would let a buffered
  // or later response bypass the malformed admitted ceiling.
  if (!effective.ok) return { decision: 'denied' };
  const effectiveMode = effective.effectiveMode;
  const mcpTool = resolveMcpToolIdentity({ toolName: args.toolName, context: args.getMcpToolContext?.(), permissionMode: parseAgentPermissionIntentV1Alias(effectiveMode) ?? 'default' });
  if (isWorkspaceWriteDeniedByRole({ workspaceWrites: args.workspaceWrites, toolName: args.toolName, toolInput: args.input, mcpEffectClass: mcpTool?.decision.effectClass })) return { decision: 'denied' };

  const allowedIdentifiers = new Set<string>();
  applyAllowedToolsToAllowlist(allowedIdentifiers, args.allowedTools);
  const listed = isToolAllowedForSession(allowedIdentifiers, args.toolName, args.input);
  if (args.unlistedTools === 'deny' && !listed) return { decision: 'denied' };

  // Legacy no_tools names a shared-safe tool allowlist, not the canonical
  // read-only Action ceiling. Preserve that existing policy before adaptation.
  if (rawLower === 'no_tools') {
    return { decision: shouldAlwaysApproveExecutionRunTool(args.toolName) ? 'approved' : 'denied' };
  }

  const actionPermission = resolveProviderPermissionForHappierAction({
    toolName: args.toolName, input: args.input, permissionMode: effectiveMode,
  });
  if (actionPermission.decision) return { decision: actionPermission.decision };

  if (shouldAlwaysApproveExecutionRunTool(args.toolName)) return { decision: 'approved' };

  if (mcpTool) {
    if (mcpTool.decision.approval === 'deny') return { decision: 'denied' };
    if (mcpTool.decision.approval === 'allow') return { decision: 'approved' };
    return listed ? { decision: 'approved_for_session' } : null;
  }

  if (effectiveMode === 'read-only' || effectiveMode === 'plan') {
    const normalizedToolName = String(args.toolName ?? '').trim().toLowerCase();
    // Explicit external MCP grants are independent of the builtin workspace
    // write ceiling. Role denial and causal admission were checked above.
    if (listed && normalizedToolName.startsWith('mcp__')) return { decision: 'approved_for_session' };
    if (
      normalizedToolName === 'bash'
      || normalizedToolName === 'shell'
      || normalizedToolName === 'execute'
    ) {
      const command = extractShellCommand(args.input);
      if (command && EXECUTION_RUN_EXACT_READ_ONLY_SHELL_COMMANDS.has(command.trim())) {
        return { decision: 'approved' };
      }
    }
    return isExecutionRunWriteLikeToolName(args.toolName) ? { decision: 'denied' } : { decision: 'approved' };
  }

  if (listed) return { decision: 'approved_for_session' };

  if (effectiveMode === 'yolo') {
    return { decision: 'approved_for_session' };
  }

  if (effectiveMode === 'safe-yolo') {
    return { decision: 'approved_for_session' };
  }

  // Default (and other interactive-ish modes): require an explicit response.
  return null;
}

/**
 * Deterministic execution-run permission decision used by non-interactive call sites that cannot
 * block on a prompt loop.
 *
 * If the permission mode would normally require an interactive response, this fails closed by
 * denying rather than auto-approving.
 */
export function resolveExecutionRunPermissionDecision(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  toolName: string;
  input?: unknown;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  getMcpToolContext?: () => McpToolPolicyContext | null;
}>): 'approved_for_session' | 'denied' {
  const immediate = resolveExecutionRunImmediateDecision(args);
  if (!immediate) return 'denied';
  return immediate.decision === 'denied' ? 'denied' : 'approved_for_session';
}

export function createExecutionRunPermissionHandler(args: Readonly<{
  permissionMode: string;
  allowedTools?: AgentSessionConfigurationSnapshotV1['allowedTools'];
  unlistedTools?: AgentSessionConfigurationSnapshotV1['unlistedTools'];
  workspaceWrites?: 'allow' | 'deny';
  backendId: string;
  causalPermissionAuthority?: AcpPermissionCausalAuthority;
  getMcpToolContext?: () => McpToolPolicyContext | null;
  publishPendingRequest?: (request: Readonly<{
    requestId: string;
    toolName: string;
    toolInput: unknown;
    turnId?: string;
    mcpTool?: ResolvedMcpToolIdentityV1;
  }>) => Promise<void> | void;
  }>): ExecutionRunPermissionHandler {
  const pending = new Map<string, { resolve: (value: { decision: 'approved' | 'denied' }) => void; readCurrentDecision: () => ReturnType<typeof resolveExecutionRunImmediateDecision>; preparing?: boolean }>();

  function respondToPermissionRequest(toolCallId: string, approved: boolean): boolean {
    const request = pending.get(toolCallId) ?? null;
    if (!request || request.preparing) return false;
    pending.delete(toolCallId);
    request.resolve({ decision: approved && request.readCurrentDecision()?.decision !== 'denied' ? 'approved' : 'denied' });
    return true;
  }

  function readImmediate(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ) {
    const immediate = resolveExecutionRunImmediateDecision({
      permissionMode: args.permissionMode,
      allowedTools: args.allowedTools,
      unlistedTools: args.unlistedTools,
      workspaceWrites: args.workspaceWrites,
      backendId: args.backendId,
      toolName,
      input,
      getMcpToolContext: args.getMcpToolContext,
      ...(Object.prototype.hasOwnProperty.call(args, 'causalPermissionAuthority')
        ? { causalPermissionAuthority: args.causalPermissionAuthority }
        : {}),
      ...(context ? { context } : {}),
    });
    return immediate;
  }

  return {
    respondToPermissionRequest,
    getImmediateDecision(toolCallId, toolName, input, context) {
      return readImmediate(toolCallId, toolName, input, context);
    },
    async handleToolCall(toolCallId, toolName, input, context) {
      const catalogPreparation = prepareMcpToolCatalog({ toolName, context: args.getMcpToolContext?.() });
      if (catalogPreparation) {
        let cancelled = false;
        const cancellation = new Promise<void>(resolve => {
          pending.set(toolCallId, { preparing: true, readCurrentDecision: () => null,
            resolve: () => { cancelled = true; resolve(); } });
        });
        const request = pending.get(toolCallId);
        // Cancellation owns this waiter, never the shared catalog hydration.
        await Promise.race([catalogPreparation, cancellation]);
        if (cancelled || pending.get(toolCallId) !== request) return { decision: 'denied' };
        pending.delete(toolCallId);
      }
      const immediate = readImmediate(toolCallId, toolName, input, context);
      if (immediate) return immediate;

      if (!args.publishPendingRequest) {
        const error = Object.assign(
          new Error('Execution-run permission interaction target is unavailable'),
          { code: 'execution_run_interaction_unavailable' },
        );
        throw error;
      }
      const pendingDecision = new Promise<{ decision: 'approved' | 'denied' }>((resolve) => {
        pending.set(toolCallId, { resolve, readCurrentDecision: () => readImmediate(toolCallId, toolName, input, context) });
      });
      try {
        await args.publishPendingRequest({
          requestId: toolCallId,
          toolName,
          toolInput: input,
          ...(() => {
            const effective = resolveCausalPermissionMode({ currentPermissionMode: permissionMode(args.permissionMode), context: context ?? (args.causalPermissionAuthority ? { causalPermissionAuthority: args.causalPermissionAuthority } : undefined) });
            const mcpTool = effective.ok ? resolveMcpToolIdentity({ toolName, context: args.getMcpToolContext?.(), permissionMode: parseAgentPermissionIntentV1Alias(effective.effectiveMode) ?? 'default' }) : null;
            return mcpTool ? { mcpTool } : {};
          })(),
          ...(context?.turnId ? { turnId: context.turnId } : {}),
        });
      } catch (error) {
        pending.delete(toolCallId);
        throw error;
      }
      return await pendingDecision;
    },
    async abortPendingRequestAndFlush(toolCallId) {
      const request = pending.get(toolCallId);
      if (!request) return;
      pending.delete(toolCallId);
      request.resolve({ decision: 'denied' });
    },
    async abortPendingRequestsAndFlush() {
      const requests = [...pending.values()];
      pending.clear();
      for (const request of requests) request.resolve({ decision: 'denied' });
    },
  };
}
