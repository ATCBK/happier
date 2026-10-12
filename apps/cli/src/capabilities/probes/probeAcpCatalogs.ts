import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentPreflightJsonRpcRequestClientV1 } from '@happier-dev/plugin-sdk/agents/runtime';

export type AcpCatalogsProbeResult = Readonly<{
  commands: unknown[] | null;
  skills: unknown[] | null;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

type AcpPreflightSessionParams = Readonly<{
  client: AgentPreflightJsonRpcRequestClientV1;
  cwd: string;
  signal: AbortSignal;
  authenticationMethodId?: string;
  selectAuthentication?: (initializeResult: JsonValue) => Readonly<{ methodId: string; metadata?: JsonValue }> | null;
}>;

async function withAcpPreflightSession<TResult>(
  params: AcpPreflightSessionParams,
  inspect: (session: Readonly<Record<string, unknown>>, readCommands: () => Promise<unknown[]>) => Promise<TResult> | TResult,
): Promise<TResult> {
  params.signal.throwIfAborted();
  let nativeSessionId: string | null = null;
  let supportsClose = false;
  const snapshots = new Map<string, unknown[]>();
  let resolveCommands!: (commands: unknown[]) => void;
  const commandsUpdate = new Promise<unknown[]>((resolve) => { resolveCommands = resolve; });
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(params.signal.reason ?? new Error('ACP catalog probe was aborted'));
    params.signal.addEventListener('abort', onAbort, { once: true });
  });
  const permissions = params.client.onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }));
  const notifications = params.client.onNotification((message) => {
    if (message.method !== 'session/update') return;
    const notification = asRecord(message.params);
    const update = asRecord(notification?.update);
    if (update?.sessionUpdate !== 'available_commands_update' || !Array.isArray(update.availableCommands)) return;
    const sessionId = notification?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return;
    if (nativeSessionId === null) snapshots.set(sessionId, update.availableCommands);
    else if (nativeSessionId === sessionId) resolveCommands(update.availableCommands);
  });
  try {
    const discover = async (): Promise<TResult> => {
      const initializeResult = await params.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const initialized = asRecord(initializeResult);
      params.signal.throwIfAborted();
      const capabilities = asRecord(asRecord(initialized?.agentCapabilities)?.sessionCapabilities);
      supportsClose = asRecord(capabilities?.close) !== null;
      const authentication = params.selectAuthentication
        ? params.selectAuthentication(initializeResult)
        : params.authenticationMethodId ? { methodId: params.authenticationMethodId } : null;
      if (authentication) {
        const methods = initialized?.authMethods;
        if (!Array.isArray(methods) || !methods.some((method) => asRecord(method)?.id === authentication.methodId)) {
          throw new Error('Declared ACP authentication method was not advertised');
        }
        await params.client.request('authenticate', { methodId: authentication.methodId, ...(authentication.metadata === undefined ? {} : { _meta: authentication.metadata }) });
      }
      params.signal.throwIfAborted();
      const session = asRecord(await params.client.request('session/new', { cwd: params.cwd, mcpServers: [] }));
      const sessionId = session?.sessionId;
      if (!session || typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('ACP session/new omitted its native session identifier');
      nativeSessionId = sessionId;
      params.signal.throwIfAborted();
      const snapshot = snapshots.get(sessionId);
      if (snapshot !== undefined) resolveCommands(snapshot);
      snapshots.clear();
      return await inspect(session, () => commandsUpdate);
    };
    return await Promise.race([discover(), cancelled]);
  } finally {
    params.signal.removeEventListener('abort', onAbort);
    try {
      // Once cancelled, the host's same bounded client cannot issue further requests.
      // Process disposal remains with the executor; no second client or cleanup budget is created.
      if (nativeSessionId !== null && supportsClose && !params.signal.aborted) {
        await params.client.request('session/close', { sessionId: nativeSessionId });
      }
    } finally {
      await notifications.dispose();
      await permissions.dispose();
    }
  }
}


export async function probeAcpCatalogs(params: AcpPreflightSessionParams): Promise<AcpCatalogsProbeResult> {
  return await withAcpPreflightSession(params, async (_session, readCommands) => ({
    commands: await readCommands(), skills: null,
  }));
}

/** Session controls are available at session/new and do not require a command update. */
export async function probeAcpSessionControls(params: AcpPreflightSessionParams): Promise<Readonly<{
  models: unknown;
  modes: unknown;
  configOptions: unknown;
}>> {
  return await withAcpPreflightSession(params, (session) => ({
    models: asRecord(session.models)?.availableModels ?? null,
    modes: asRecord(session.modes)?.availableModes ?? null,
    configOptions: session.configOptions ?? null,
  }));
}
