import { isPluginError, isRecord, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import {
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1,
  CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
} from '@happier-dev/plugin-sdk/first-party/connected-accounts';
import type {
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentExecutionRunEvent,
  AgentRuntimeContext,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';

import { buildOpenCodeQualifiedAuthContent } from './materialize/index.js';
import {
  OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
  OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
  OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS,
  OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
  OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID,
  type OpenCodeConnectedAccountPurposeId,
} from './purposes.js';

type Binding = Awaited<ReturnType<
  AgentRuntimeContext['services']['connectedAccounts']['getBinding']
>>;

type ExpectedService = Readonly<{ pluginId: string; localId: string }>;

const EXPECTED_SERVICES = Object.freeze({
  [OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'claude-subscription',
  }),
  [OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.codex',
    localId: 'openai-codex',
  }),
  [OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.voice.openai',
    localId: 'openai',
  }),
  [OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID]: Object.freeze({
    pluginId: 'happier.agent.claude',
    localId: 'anthropic',
  }),
} satisfies Readonly<Record<OpenCodeConnectedAccountPurposeId, ExpectedService>>);

const OPEN_CODE_NATIVE_AUTH_ENV_KEYS = Object.freeze([
  'OPENCODE_AUTH_CONTENT',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
] as const);

export type PreparedOpenCodeQualifiedConnectedAccounts<
  Request extends AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
> = Readonly<{
  request: Request;
  isInvalidated(): boolean;
  bindSession(session: AgentSessionRuntime): AgentSessionRuntime;
  bindExecutionRun(runtime: AgentExecutionRunRuntime): AgentExecutionRunRuntime;
  dispose(): Promise<void>;
}>;

function assertExpectedBinding(
  purpose: OpenCodeConnectedAccountPurposeId,
  binding: Binding,
): binding is NonNullable<Binding> {
  if (!binding) return false;
  const expected = EXPECTED_SERVICES[purpose];
  if (
    binding.purpose !== purpose
    || binding.service.pluginId !== expected.pluginId
    || binding.service.localId !== expected.localId
  ) {
    throw new Error(`OpenCode connected-account purpose ${purpose} resolved an unexpected binding`);
  }
  return true;
}

function readExactEnvironmentValue(
  purpose: OpenCodeConnectedAccountPurposeId,
  materialized: Awaited<ReturnType<
    AgentRuntimeContext['services']['connectedAccounts']['materialize']
  >>,
  key: string,
): string {
  if (materialized.kind !== 'environment') {
    throw new Error(`OpenCode ${purpose} returned an invalid environment materialization`);
  }
  const keys = Object.keys(materialized.env);
  if (keys.some((candidate) => candidate !== key)) {
    throw new Error(`OpenCode ${purpose} returned an unrequested environment materialization`);
  }
  const value = materialized.env[key] ?? '';
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`OpenCode ${purpose} did not materialize ${key}`);
  }
  return value;
}

function mergeQualifiedLaunchEnvironment(input: Readonly<{
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest;
  authContent: string;
}>): AgentSessionOpenRequest | AgentExecutionRunOpenRequest {
  const values = { ...(input.request.launchEnvironment?.values ?? {}) };
  for (const key of OPEN_CODE_NATIVE_AUTH_ENV_KEYS) delete values[key];
  Object.assign(values, {
    OPENCODE_AUTH_CONTENT: input.authContent,
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  });
  const valueKeys = new Set(Object.keys(values));
  const unset = new Set(
    (input.request.launchEnvironment?.unset ?? []).filter((key) => !valueKeys.has(key)),
  );
  unset.add(CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey);
  return Object.freeze({
    ...input.request,
    launchEnvironment: Object.freeze({
      values: Object.freeze(values),
      unset: Object.freeze([...unset]),
    }),
  });
}

async function waitForInitialPurposeObservations(
  observations: Iterable<Promise<void>>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await Promise.all(observations);
    return;
  }
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('OpenCode qualified Connected Account preparation was aborted.');
  if (signal.aborted) throw abortError();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([Promise.all(observations), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function prepareOpenCodeQualifiedConnectedAccounts(
  request: AgentSessionOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedOpenCodeQualifiedConnectedAccounts<AgentSessionOpenRequest>>;
export function prepareOpenCodeQualifiedConnectedAccounts(
  request: AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedOpenCodeQualifiedConnectedAccounts<AgentExecutionRunOpenRequest>>;
export async function prepareOpenCodeQualifiedConnectedAccounts(
  request: AgentSessionOpenRequest | AgentExecutionRunOpenRequest,
  context: AgentRuntimeContext,
): Promise<PreparedOpenCodeQualifiedConnectedAccounts<AgentSessionOpenRequest | AgentExecutionRunOpenRequest>> {
  // A Provider binding is the complete model credential authority. Selected
  // native OpenCode accounts must not be consulted or merged into that launch.
  if (request.providerBinding !== undefined) {
    return Object.freeze({
      request,
      isInvalidated: () => context.signal?.aborted === true,
      bindSession: (session) => session,
      bindExecutionRun: (runtime) => runtime,
      async dispose() {},
    });
  }
  const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
  let invalidated = false;
  let invalidationHandler: (() => Promise<void>) | null = null;
  let disposed = false;
  const initialObservations = new Map<OpenCodeConnectedAccountPurposeId, Promise<void>>();
  const resolveInitial = new Map<OpenCodeConnectedAccountPurposeId, () => void>();

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  };
  const invalidate = async (): Promise<void> => {
    invalidated = true;
    await invalidationHandler?.();
  };

  try {
    for (const purpose of OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      initialObservations.set(purpose, new Promise<void>((resolve) => {
        resolveInitial.set(purpose, resolve);
      }));
      let initial = true;
      subscriptions.push(context.services.connectedAccounts.watch(purpose, () => {
        if (initial) {
          initial = false;
          resolveInitial.get(purpose)?.();
          resolveInitial.delete(purpose);
          return;
        }
        return invalidate();
      }));
    }
    await waitForInitialPurposeObservations(initialObservations.values(), context.signal);

    const bindingEntries = await Promise.all(
      OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS.map(async (purpose) => [
        purpose,
        await context.services.connectedAccounts.getBinding(
          purpose,
          { signal: context.signal },
        ),
      ] as const),
    );
    const bindings = Object.fromEntries(bindingEntries) as Record<
      OpenCodeConnectedAccountPurposeId,
      Binding
    >;
    for (const purpose of OPEN_CODE_CONNECTED_ACCOUNT_PURPOSE_IDS) {
      assertExpectedBinding(purpose, bindings[purpose]);
    }
    const openAiCodexBinding = bindings[OPEN_CODE_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID];
    const openAiBinding = bindings[OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID];
    const anthropicRequestAuthBinding = bindings[OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID];
    const anthropicBinding = bindings[OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID];

    const directAccountCredentials: Partial<Record<'openai' | 'anthropic', Readonly<{ key: string; service: PluginContributionRef }>>> = {};
    const requiredRequestAuthProviders: Array<'openai' | 'anthropic'> = [];
    let usedBinding = false;

    if (openAiCodexBinding) {
      usedBinding = true;
      requiredRequestAuthProviders.push('openai');
    } else if (openAiBinding) {
      usedBinding = true;
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['OPENAI_API_KEY'] },
        { signal: context.signal, expectedAccount: openAiBinding.account },
      );
      directAccountCredentials.openai = { key: readExactEnvironmentValue(
        OPEN_CODE_OPENAI_API_KEY_PURPOSE_ID,
        materialized,
        'OPENAI_API_KEY',
      ), service: openAiBinding.service };
    }

    if (anthropicRequestAuthBinding) {
      usedBinding = true;
      try {
        const materialized = await context.services.connectedAccounts.materialize(
          OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          CLAUDE_SUBSCRIPTION_SETUP_TOKEN_ENVIRONMENT_REQUEST_V1,
          {
            signal: context.signal,
            expectedAccount: anthropicRequestAuthBinding.account,
          },
        );
        const setupToken = readExactEnvironmentValue(
          OPEN_CODE_ANTHROPIC_REQUEST_AUTH_PURPOSE_ID,
          materialized,
          CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.setupToken.environmentKey,
        );
        directAccountCredentials.anthropic = { key: setupToken, service: anthropicRequestAuthBinding.service };
      } catch (error) {
        if (
          !isPluginError(error)
          || error.code
            !== CLAUDE_SUBSCRIPTION_MATERIALIZATION_CONTRACT_V1.oauth
              .requestAuthRequiredErrorCode
        ) {
          throw error;
        }
        requiredRequestAuthProviders.push('anthropic');
      }
    } else if (anthropicBinding) {
      usedBinding = true;
      const materialized = await context.services.connectedAccounts.materialize(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
        { signal: context.signal, expectedAccount: anthropicBinding.account },
      );
      directAccountCredentials.anthropic = { key: readExactEnvironmentValue(
        OPEN_CODE_ANTHROPIC_API_KEY_PURPOSE_ID,
        materialized,
        'ANTHROPIC_API_KEY',
      ), service: anthropicBinding.service };
    }

    const qualifiedAuth = usedBinding ? buildOpenCodeQualifiedAuthContent({
      baseAuthContent: request.launchEnvironment?.values.OPENCODE_AUTH_CONTENT,
      directAccountCredentials,
      requiredRequestAuthProviders,
    }) : null;
    const preparedRequest = qualifiedAuth
      ? mergeQualifiedLaunchEnvironment({
          request,
          authContent: qualifiedAuth.authContent,
        })
      : request;

    function projectNativeAccountFailure<Event extends AgentSessionRuntimeEvent | AgentExecutionRunEvent>(event: Event): Event {
      if (invalidated || disposed || context.signal?.aborted || !qualifiedAuth
        || (event.kind !== 'turn-failed' && event.kind !== 'run-failed')) return event;
      const diagnostic = event.diagnostic;
      if (!diagnostic || !isRecord(diagnostic.details)) return event;
      const evidence = diagnostic.details.nativeProviderFailure;
      if (!isRecord(evidence) || evidence.httpStatus !== 429
        || (evidence.providerId !== 'openai' && evidence.providerId !== 'anthropic')) return event;
      const service = qualifiedAuth.nativeAccountServicesByProvider[evidence.providerId];
      if (!service) return event; // Proxy slots already report exact failures at their request-auth leaf.
      const classification = {
        kind: 'rate_limit', limitCategory: 'rate_limit', quotaScope: 'unknown',
        serviceId: `${service.pluginId}/${service.localId}`, profileId: null, groupId: null,
        resetsAtMs: null, retryAfterMs: null, planType: null, rateLimits: null,
        source: 'structured_provider_error',
      };
      return { ...event, diagnostic: { ...diagnostic, details: {
        ...diagnostic.details, runtimeAuthClassification: AgentRuntimeJsonValueSchema.parse(classification),
      } } };
    }
    const hasDirectAccountSource = qualifiedAuth
      && Object.keys(qualifiedAuth.nativeAccountServicesByProvider).length > 0;

    return Object.freeze({
      request: preparedRequest,
      isInvalidated: () => invalidated || context.signal?.aborted === true,
      bindSession(session) {
        let sessionDisposed = false;
        const watch: AgentSessionRuntime['watch'] = listener => session.watch(event => listener(projectNativeAccountFailure(event)));
        const preparedSession: AgentSessionRuntime = {
          ...session,
          watch: hasDirectAccountSource ? watch : session.watch,
          async dispose(reason) {
            if (sessionDisposed) return;
            sessionDisposed = true;
            await dispose();
            await session.dispose(reason);
          },
        };
        invalidationHandler = async () => await preparedSession.dispose('runtime_recovery');
        if (invalidated) void invalidationHandler();
        return preparedSession;
      },
      bindExecutionRun(runtime) {
        let runtimeDisposed = false;
        const watch: AgentExecutionRunRuntime['watch'] = listener => runtime.watch(event => listener(projectNativeAccountFailure(event)));
        const preparedRuntime: AgentExecutionRunRuntime = {
          ...runtime,
          watch: hasDirectAccountSource ? watch : runtime.watch,
          async dispose() {
            if (runtimeDisposed) return;
            runtimeDisposed = true;
            await dispose();
            await runtime.dispose();
          },
        };
        invalidationHandler = async () => await preparedRuntime.dispose();
        if (invalidated) void invalidationHandler();
        return preparedRuntime;
      },
      dispose,
    });
  } catch (error) {
    await dispose();
    throw error;
  }
}
