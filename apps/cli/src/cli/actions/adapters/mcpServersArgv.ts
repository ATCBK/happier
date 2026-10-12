import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { randomUUID } from 'node:crypto';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { sameStoredCredentials } from '@/persistence';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveCurrentAccountAdministrationMachine } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { createConnectedAccountDaemonClient } from '@/cli/commands/connect/connectedAccountDaemonClient';
import { continueConnectedAccountAuthentication } from '@/cli/commands/connect';
import { parseConnectArgs } from '@/cli/commands/connect/parseConnectArgs';
import { argvBeforeOptionTerminator } from '@/cli/commands/shared/argvFlags';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from '../compiledCommands';
import { readActionCliServerId } from '../actionServerTarget';
import { composeActionCliInput, parseActionCliInput } from '../parseCommandInput';
import { type ActionCliExecutionDeps, readTransportMachineId, runCompiledActionCliCommand, stripTransportTokens } from '../executeCommand';

/** Terminal continuation only; the compiler and Connected Accounts own admission and authentication. */
export async function tryHandleMcpServerCliCommand(params: Readonly<{
  argv: readonly string[]; signal?: AbortSignal; actionExecutionDeps?: Partial<ActionCliExecutionDeps>;
}>): Promise<boolean> {
  const { argv } = params;
  if (argv[0] !== 'mcp' || argv[1] !== 'servers' || (argv[2] !== 'sign-in' && argv[2] !== 'sign-out')) return false;
  const path = argv.slice(0, 3);
  const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
  const list = findCompiledActionCliCommand(['mcp', 'servers', 'list'], listCompiledActionCliCommands());
  if (!command || !list) throw new Error('MCP Action command is unavailable');
  const options = argvBeforeOptionTerminator(argv);
  if (options.includes('--help') || options.includes('-h')) {
    await runCompiledActionCliCommand({ command, argv, signal: params.signal, deps: params.actionExecutionDeps });
    return true;
  }
  const noOpen = options.includes('--no-open');
  const callerTokens = stripTransportTokens(list, argv.slice(3)).filter(token => token !== '--no-open');
  const parsed = parseActionCliInput(command, callerTokens);
  if (!parsed.ok) throw Object.assign(new Error(parsed.message), { code: parsed.code });
  const requestedName = parsed.callerOverlay.itemId;
  if (typeof requestedName !== 'string' || !requestedName) throw Object.assign(new Error('Supply an MCP server name or id'), { code: 'invalid_arguments' });
  const serverId = readActionCliServerId(argv, true);
  const preferredMachineId = readTransportMachineId(list, argv);
  const transport = [...(serverId ? ['--server-id', serverId] : []), ...(preferredMachineId ? ['--machine-id', preferredMachineId] : [])];
  let captured: { params: Parameters<ActionCliExecutionDeps['createExecutorFn']>[0]; executor: Awaited<ReturnType<ActionCliExecutionDeps['createExecutorFn']>>;
    homeId: string; homeUrl: string } | undefined;
  const create = params.actionExecutionDeps?.createExecutorFn ?? (async input =>
    (await import('@/session/actions/createCliActionExecutorFromCredentials')).createCliActionExecutorFromCredentials(input));
  const deps: Partial<ActionCliExecutionDeps> = { ...params.actionExecutionDeps,
    createExecutorFn: async input => {
      const homeId = input.serverId ?? configuration.activeServerId;
      const homeUrl = normalizeServerHttpBaseUrl(input.serverApiUrl ?? configuration.apiServerUrl);
      if (captured && (!sameStoredCredentials(captured.params.credentials, input.credentials)
        || captured.homeId !== homeId || captured.homeUrl !== homeUrl
        || captured.params.serverIdentityId !== input.serverIdentityId)) {
        throw Object.assign(new Error('MCP sign-in Account or Home is no longer current'), { code: 'client_refused' });
      }
      const executor = captured?.executor ?? await create(input);
      captured ??= { params: input, executor, homeId, homeUrl };
      return executor;
    } };
  let resolvedId: string | undefined;
  await runCompiledActionCliCommand({ command: list, argv: [...list.path, ...transport], signal: params.signal, deps,
    consumeSuccess: payload => {
      const snapshot = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.list'].parse(payload);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') throw Object.assign(new Error('MCP catalog is unavailable'), { code: 'mcp_catalog_unavailable' });
      resolvedId = snapshot.catalog.servers.find(server => server.id === requestedName || server.name === requestedName)?.id;
      if (!resolvedId) throw Object.assign(new Error('MCP server was not found'), { code: 'mcp_server_not_found' });
      return true;
    } });
  if (!captured || !resolvedId) return true;
  const current = captured;
  const composeArgv = (machineId?: string) => {
    const composed = composeActionCliInput({ parsed: { ...parsed, callerOverlay: { ...parsed.callerOverlay, itemId: resolvedId,
      ...(argv[2] === 'sign-out' && machineId ? { machineId } : {}) } }, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: randomUUID(), commandPath: command.path, output: options.includes('--json') ? 'json' : 'human' } });
    if (!composed.ok) throw Object.assign(new Error(composed.message), { code: composed.code });
    return [...path, '--input-json', JSON.stringify(composed.input), ...(serverId ? ['--server-id', serverId] : []),
      ...(options.includes('--json') ? ['--json'] : []), ...(command.routesByTransportMachineId && machineId ? ['--machine-id', machineId] : [])];
  };
  if (argv[2] === 'sign-out') {
    const machineId = await resolveCurrentAccountAdministrationMachine({ token: current.params.credentials.token,
      serverHttpBaseUrl: current.homeUrl, preferredMachineId, signal: params.signal });
    if (!machineId) throw Object.assign(new Error('No machine is online'), { code: 'no_machine_online' });
    await runCompiledActionCliCommand({ command, argv: composeArgv(machineId), signal: params.signal, deps });
    return true;
  }
  await runCompiledActionCliCommand({ command, argv: composeArgv(preferredMachineId ?? undefined), signal: params.signal, deps,
    consumeSuccess: async payload => {
      if (options.includes('--json')) return false;
      const started = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.signIn.start'].parse(payload);
      const client = createConnectedAccountDaemonClient({ credentials: current.params.credentials,
        machineId: started.machineId, actionExecutor: current.executor, signal: params.signal });
      const described = await client.control({ operation: 'describeService', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 });
      if (described.status !== 'described') throw new Error('MCP sign-in service is unavailable');
      const mode = described.descriptor.authentication.modes.find(mode => mode.id === 'oauth');
      if (!mode || mode.kind !== 'oauthAuthorizationCode' || !mode.callbackUrl) throw new Error('MCP OAuth mode is unavailable');
      await continueConnectedAccountAuthentication({ client, described,
        intent: { kind: 'connect', service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, modeId: 'oauth' },
        initial: { status: 'awaitingOAuth', attemptId: started.attemptId, authorizationUrl: started.authorizationUrl,
          callbackUrl: mode.callbackUrl, expiresAtMs: started.expiresAtMs },
        options: parseConnectArgs(['--oauth', ...(noOpen ? ['--no-open'] : [])]).options, signal: params.signal });
      return true;
    } });
  return true;
}
