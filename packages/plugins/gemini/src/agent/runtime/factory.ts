import {
  type AgentRuntimeContext,
  type AgentRuntimeFactory,
  type AgentExecutionRunOpenRequest,
  type AgentExecutionRunRuntime,
  type AgentExecutionRunEvent,
  type AgentExecutionRunRuntimeContextV1,
  type AgentSessionOpenRequest,
  type AgentSessionRuntime,
  type AgentSessionRuntimeEvent,
  AgentRuntimeJsonValueSchema,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isRecord } from '@happier-dev/plugin-sdk';

export { geminiExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

import { GEMINI_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { buildGeminiAcpToolNameResolver } from '../acp/toolNames.js';
import {
  GEMINI_ACP_AUTH_META_ENV,
  GEMINI_ACP_AUTH_METHOD_ENV,
  resolveGeminiAcpFlag,
  resolveGeminiApiKeyFromEnv,
  resolveGeminiAuthConfig,
} from '../auth/resolution.js';
import { prepareGeminiNativeMcpShaping } from '../mcp/shaping.js';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from '../connectedServices/runtimeAuthAdapter.js';

const geminiRuntimeAuthAdapter = createGeminiConnectedServiceRuntimeAuthAdapter();

function projectGeminiRuntimeAuthFailure<Event extends AgentSessionRuntimeEvent | AgentExecutionRunEvent>(event: Event): Event {
  if (event.kind !== 'turn-failed' && event.kind !== 'run-failed' && event.kind !== 'input-rejected') return event;
  const diagnostic = event.diagnostic;
  if (!diagnostic || !isRecord(diagnostic.details)) return event;
  const classification = geminiRuntimeAuthAdapter.classifyRuntimeAuthFailure({ target: { agentId: 'gemini' }, error: diagnostic });
  if (!classification) return event;
  return { ...event, diagnostic: { ...diagnostic, details: {
    ...diagnostic.details, runtimeAuthClassification: AgentRuntimeJsonValueSchema.parse(classification),
  } } };
}

function buildGeminiLaunchEnvironment(
  values: Readonly<Record<string, string>>,
  unset: readonly string[],
): Readonly<Record<string, string | undefined>> {
  const env: Record<string, string | undefined> = { ...values };
  for (const key of unset) delete env[key];
  return env;
}

function ignoredGeminiAcpAuthControlEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overlay: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_METHOD_ENV)) overlay[GEMINI_ACP_AUTH_METHOD_ENV] = '';
  if (Object.prototype.hasOwnProperty.call(env, GEMINI_ACP_AUTH_META_ENV)) overlay[GEMINI_ACP_AUTH_META_ENV] = '';
  return overlay;
}

async function openGeminiSession(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<AgentSessionRuntime> {
  const runtime = await openGeminiAcpRuntime(request, context, (preparedRequest, options) => (
    context.protocols.acp.open(preparedRequest as AgentSessionOpenRequest, options)
  ));
  return { ...runtime, watch(listener) { return runtime.watch(event => listener(projectGeminiRuntimeAuthFailure(event))); } };
}

async function openGeminiExecutionRun(
  request: AgentExecutionRunOpenRequest,
  context: AgentExecutionRunRuntimeContextV1,
): Promise<AgentExecutionRunRuntime> {
  const runtime = await openGeminiAcpRuntime(request, context, (preparedRequest, options) => (
    context.protocols.acp.openExecutionRunV1(preparedRequest as AgentExecutionRunOpenRequest, options)
  ));
  return { ...runtime, watch(listener) { return runtime.watch(event => listener(projectGeminiRuntimeAuthFailure(event))); } };
}

async function openGeminiAcpRuntime<Runtime extends Readonly<{ dispose(): void | Promise<void> }>>(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  context: Pick<AgentRuntimeContext, 'services' | 'signal'>,
  open: (
    request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
    options: Parameters<AgentRuntimeContext['protocols']['acp']['open']>[1],
  ) => Promise<Runtime>,
): Promise<Runtime> {
  const requestedLaunchEnvironment = request.launchEnvironment ?? { values: {}, unset: [] };
  const sourceEnv = buildGeminiLaunchEnvironment(
    requestedLaunchEnvironment.values,
    requestedLaunchEnvironment.unset,
  );
  const auth = resolveGeminiAuthConfig(sourceEnv, resolveGeminiApiKeyFromEnv(sourceEnv));
  const authControlEnv = ignoredGeminiAcpAuthControlEnv(sourceEnv);
  const noTools = request.configuration?.unlistedTools === 'deny' && request.configuration.allowedTools?.length === 0;
  let shaping: Awaited<ReturnType<typeof prepareGeminiNativeMcpShaping>>;
  let skillsDelivered = request.skills ? true : undefined;
  try {
    shaping = await prepareGeminiNativeMcpShaping(sourceEnv, request.configuration, request.skills);
  } catch (error) {
    if (!request.skills) throw error;
    // Reuse the native-home owner without the optional skills after failed delivery.
    shaping = await prepareGeminiNativeMcpShaping(sourceEnv, request.configuration);
    skillsDelivered = false;
  }
  try {
    const launchEnvironmentOverrides = {
      ...shaping.env,
      ...authControlEnv,
      ...(auth.launchEnv ?? {}),
    };
    const flag = await resolveGeminiAcpFlag(context.services.exec, {
      env: {
        ...sourceEnv,
        ...launchEnvironmentOverrides,
      },
      signal: context.signal,
    });
    const launchEnvironment = {
      values: {
        ...requestedLaunchEnvironment.values,
        ...launchEnvironmentOverrides,
      },
      unset: requestedLaunchEnvironment.unset.filter(
        (key) => !Object.prototype.hasOwnProperty.call(launchEnvironmentOverrides, key),
      ),
    };
    const session = await open({ ...request, launchEnvironment, ...(noTools ? { mcpServers: {} } : {}) }, {
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'gemini-cli' },
        args: [flag],
        env: shaping.env,
        timeouts: {
          initializeMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.initMs,
          idleMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.idleMs,
          toolCallMs: GEMINI_ACP_RUNTIME_DEFINITION.timeouts.toolCallMs,
        },
      },
      definition: { ...GEMINI_ACP_RUNTIME_DEFINITION, toolNameResolver: buildGeminiAcpToolNameResolver(request) },
    });
    let disposed = false;
    return {
      ...session,
      ...(skillsDelivered !== undefined ? { skillsDelivered } : {}),
      async dispose() {
        if (disposed) return;
        disposed = true;
        try {
          await session.dispose();
        } finally {
          await shaping.cleanup();
        }
      },
    };
  } catch (error) {
    await shaping.cleanup();
    throw error;
  }
}

export const createGeminiAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open: openGeminiSession,
    executionRunContextV1: { open: openGeminiExecutionRun },
  },
});
