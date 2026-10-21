import { createHash, randomUUID } from 'node:crypto';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { ACTION_ID_FAMILIES_V1, ActionIdSchema, isPluginDevLoopActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { WaitActionInputV1Schema } from '@happier-dev/protocol/actions/specs/wait';
import type { ActionExecuteResult, ActionExecutorContext, ActionId } from '@happier-dev/protocol';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { configuration } from '@/configuration';
import { HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY,
  readCurrentRunnerAgentRuntimeDaemonServiceAuthority } from '@/daemon/agentRuntime/sessionBridgeAuthorization';
import { dispatchCurrentAgentRuntimeDaemonServiceRequest,
  isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceAuthorityClient';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { WorkflowProjectTargetV1Schema } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { requiresExplicitScmMachineTarget } from '@happier-dev/protocol/actions/actionSpecs';
import { readContributedActionExecutionPlacement } from '@/session/actions/readContributedActionExecutionPlacement';

type ActionExecutor = Readonly<{
  execute(actionId: ActionId, input: unknown, context?: ActionExecutorContext): Promise<ActionExecuteResult>;
}>;

const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });
const uncertain = (): ActionExecuteResult => ({ ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain' });

// These readers use the bound host's live Session RPC/catalog, including in a
// daemonless host. Reading another Session still needs credentialed transport.
const BOUND_SESSION_RPC_READS: ReadonlySet<ActionId> = new Set([
  'review.engines.list', 'session.work_state.get', 'session.goal.get',
  'session.vendor_plugin_catalog.list', 'session.skill_catalog.list',
]);

/** Account credentials stay in the daemon; identity comes from its existing Session capability. */
export function createSessionAccountActionExecutor(params: Readonly<{
  base: ActionExecutor;
  client: HappyMcpSessionClient;
  /** Credentialed hosts already have the shared exact-Machine Action adapter. */
  hasAccountAuthority?: boolean;
}>): ActionExecutor {
  const execute = async (actionId: ActionId, input: unknown, context?: ActionExecutorContext,
    routingDescriptorRead = false): Promise<ActionExecuteResult> => {
      // These reads describe the bound host's admitted catalog, not Account data.
      // Keep its live Session policy (including memory choice) at the existing
      // executor rather than replacing it with the daemon's Account catalog.
      if (!routingDescriptorRead && (actionId === 'action.spec.search' || actionId === 'action.spec.get')) {
        return await params.base.execute(actionId, input, context);
      }
      // Restricted child reads use the bound Session's admitted corpus reader.
      // Account forwarding would replace that authority with the daemon's scope.
      if (actionId === 'session.list' && context?.sessionListAccess === 'current_session') {
        return await params.base.execute(actionId, input, context);
      }
      // Contributed ids remain with the existing plugin catalog/execution owner.
      const builtIn = ActionIdSchema.safeParse(actionId);
      const spec = builtIn.success ? getActionSpec(builtIn.data) : null;
      if (requiresExplicitScmMachineTarget(actionId)) return await params.base.execute(actionId, input, context);
      let executionPlacement = spec ? resolveActionExecutionPlacementForInput(spec, input) : null;
      if (actionId === 'action.invoke' && !params.hasAccountAuthority) {
        // Account-only releases need not exist in the bound Machine catalog.
        // This host-private read uses the same capability, witness and lifetime;
        // author-facing discovery above retains the bound Session policy.
        const actual = await readContributedActionExecutionPlacement(input,
          request => execute('action.spec.get', request, context, true));
        if (!actual) return await params.base.execute(actionId, input, context);
        if (!actual.ok) return actual.failure;
        // Only Account placement changes this wrapper's incumbent routing.
        // A client handler still follows its existing Machine/UI corridor.
        if (actual.placement === 'account') executionPlacement = 'account';
      }
      const requestedSessionId = input && typeof input === 'object' && 'sessionId' in input
        && typeof input.sessionId === 'string' ? input.sessionId.trim() : params.client.sessionId;
      // The bound host holds its own Board stored-content key. Other
      // Session readers use the credentialed owner, including reads of children.
      const boundRead = requestedSessionId === params.client.sessionId
        && (BOUND_SESSION_RPC_READS.has(actionId)
          || ACTION_ID_FAMILIES_V1.session_board.some(id => id === actionId)
          || ACTION_ID_FAMILIES_V1.subagent_registry.some(id => id === actionId)
          || ACTION_ID_FAMILIES_V1.session_permissions.some(id => id === actionId));
      const sessionRead = executionPlacement === 'session' && !boundRead && spec?.sideEffectClass === 'read';
      // These lifecycle owners resolve credentialed Session/Machine transport.
      // Forward through the same capability channel as reads; the credentialed
      // executor still owns current-Session scope and approval policy. Explicit
      // headless resume is Session-placed; navigation keeps client placement.
      const sessionLifecycle = executionPlacement === 'session'
        && (actionId === 'session.stop' || actionId === 'session.archive' || actionId === 'session.unarchive'
          || actionId === 'session.fork' || actionId === 'session.open');
      // Persisted readers are Machine-placed so an offline Session does not need
      // its original runner. Keep their established credentialed implementation.
      const persistedRead = executionPlacement === 'machine'
        && (ACTION_ID_FAMILIES_V1.session_transcripts.some(id => id === actionId)
          || actionId === 'session.history.get' || actionId === 'session.messages.recent.get');
      if (!builtIn.success || (executionPlacement !== 'account'
        && executionPlacement !== 'client'
        && !sessionRead && !persistedRead && !sessionLifecycle
        && builtIn.data !== 'session.spawn_new'
        // Admission inspects the executing Machine's workspace and plugin
        // runtime before sealing Account storage; a Session runner has neither.
        && builtIn.data !== 'workflow.run.start'
        // SCM uses the target daemon's admitted backends. Restricted runners
        // reach the credentialed shared adapter through this existing capability.
        && !(builtIn.data.startsWith('scm.') && !params.hasAccountAuthority)
        // Machine plugin policy and lifecycle belong to the daemon's canonical
        // plugin-change owner, never to the restricted Session runner.
        && !(isPluginDevLoopActionIdV1(builtIn.data) && executionPlacement === 'machine')
        && !(Object.hasOwn(RoleActionInputSchemasV1, builtIn.data) && builtIn.data.startsWith('session.')))) {
        return await params.base.execute(actionId, input, context);
      }
      // This daemon Action channel returns one result, not a passive snapshot
      // feed. Never drop the sink and turn watch into a blocking condition wait.
      if (actionId === 'wait' && context?.onWaitSnapshot) {
        const request = WaitActionInputV1Schema.safeParse(input);
        if (!request.success) return { ok: false, errorCode: 'invalid_action_input', error: 'invalid_action_input' };
        return { ok: true, result: { target: request.data.target, condition: request.data.condition,
          disposition: 'unsupported_condition' } };
      }
      const lifetime = params.client.getRuntimeLifetimeSignal?.();
      const signal = context?.signal && lifetime
        ? AbortSignal.any([context.signal, lifetime]) : context?.signal ?? lifetime ?? undefined;
      if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      const path = process.env[HAPPIER_AGENT_RUNTIME_DAEMON_SERVICE_AUTHORITY_FILE_ENV_KEY];
      if (!path) return unavailable();
      const hostWitness = params.client.getActiveTurnAdmissionWitness?.();
      if (!hostWitness) return unavailable();
      const binding = params.client.getSessionActionConfirmationBinding?.();
      const executionRun = binding?.run;
      if (binding && executionRun && (binding.turnId !== hostWitness.turnId || !binding.isCurrent())) return unavailable();
      const location = actionId.startsWith('scm.') ? params.client.getCurrentSessionLocation?.() : null;
      const scmWorkspace = actionId.startsWith('scm.')
        ? WorkflowProjectTargetV1Schema.safeParse({ machineId: location?.machineId, directory: location?.path }) : null;
      if (scmWorkspace && !scmWorkspace.success) return unavailable();
      let witness;
      try { witness = projectAgentRuntimeDaemonServiceTurnWitnessV1(hostWitness); }
      catch { return unavailable(); }
      const authority = await readCurrentRunnerAgentRuntimeDaemonServiceAuthority({
        happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
        path, expectedSessionId: params.client.sessionId,
      });
      if (!authority) return unavailable();
      // A spawn retry belongs to the admitted parent and public creation key,
      // independently of the MCP connection, tool call, turn or runner lifetime.
      // Hash the tuple because creation keys have no private-envelope id bound.
      const creationKey = actionId === 'session.spawn_new'
        ? SessionCreationKeyV1Schema.safeParse(input && typeof input === 'object' && 'creationKey' in input
          ? input.creationKey : undefined)
        : null;
      const requestId = creationKey?.success
        ? createHash('sha256').update(JSON.stringify(['session.spawn_new', params.client.sessionId, creationKey.data])).digest('hex')
        : context?.actionRequestId ?? randomUUID();
      const toolCallId = context?.approvalOrigin?.kind === 'transcript_tool_call'
        ? context.approvalOrigin.toolCallId : undefined;
      try {
        const response = await dispatchCurrentAgentRuntimeDaemonServiceRequest({
          authority: { happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
            path, sessionId: params.client.sessionId, runner: authority.runner, retainedAgent: authority.retainedAgent },
          // The Action owns its lifetime; waiting for its user approval has no subordinate deadline.
          timeoutMs: null,
          ...(signal ? { signal } : {}),
          createRequest: (capability) => ({ v: 1,
            context: { token: capability, sessionId: params.client.sessionId },
            operation: { kind: 'action.execute', requestId, actionId, input, witness,
              ...(scmWorkspace?.success ? { scmWorkspace: scmWorkspace.data } : {}),
              ...(context?.reviewCommentPrincipal ? { reviewCommentPrincipal: context.reviewCommentPrincipal } : {}),
              ...(executionRun ? { executionRun: { runId: executionRun.runId, occurrenceId: executionRun.occurrenceId } } : {}),
              surface: context?.surface === 'mcp' ? 'mcp' : 'agent',
              ...(toolCallId ? { toolCallId } : {}) },
          }),
        });
        if (response.ok) return response.result.kind === 'action.execution' && response.result.requestId === requestId
          ? response.result.outcome : uncertain();
        return response.error.code === NATIVE_AGENT_SESSION_EFFECT_OUTCOME_UNKNOWN_CODE ? uncertain() : unavailable();
      } catch (error) {
        if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        if (isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition(error)) return uncertain();
        throw error;
      }
    };
  return { execute: (actionId, input, context) => execute(actionId, input, context) };
}
