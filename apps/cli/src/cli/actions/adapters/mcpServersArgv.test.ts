import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createMcpServerActionExecuteV1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { executeConnectedServiceConfigurationActionV1, prepareConnectedServiceRevokeInputV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as service } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import { MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR } from '@/mcp/oauth/mcpSignInRuntime';
import { tryHandleMcpServerCliCommand } from './mcpServersArgv';

const terminal = vi.hoisted(() => ({ prompt: vi.fn(), rpc: vi.fn(), inventory: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const original = await importOriginal<typeof import('axios')>();
  return { ...original, default: { ...original.default, get: terminal.inventory } };
});
vi.mock('@/terminal/prompts/promptInput', async importOriginal => ({
  ...await importOriginal<typeof import('@/terminal/prompts/promptInput')>(), promptInput: terminal.prompt,
}));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc: terminal.rpc,
}));
afterEach(() => { terminal.prompt.mockReset(); terminal.inventory.mockReset(); vi.restoreAllMocks(); process.exitCode = 0; });

describe('MCP compiled CLI sign-in journey', () => {
  it.each([
    { name: 'positional server name', argv: ['mcp', 'servers', 'sign-in', 'linear', '--no-open'], switched: false },
    { name: 'flags before the positional name', argv: ['mcp', 'servers', 'sign-in', '--step-up', 'linear', '--no-open'], switched: false },
    { name: 'Account changes after catalog read', argv: ['mcp', 'servers', 'sign-in', 'linear', '--no-open'], switched: true },
    { name: 'sign-out through existing revoke', argv: ['mcp', 'servers', 'sign-out', 'linear'], switched: false },
  ])('resolves through the catalog Action and preserves the captured Account: $name', async ({ argv, switched }) => {
    const commands: unknown[] = [];
    const signOut = argv[2] === 'sign-out';
    terminal.inventory.mockResolvedValue({ data: [{ id: 'machine', active: true, revokedAt: null, replacedByMachineId: null }] });
    const descriptor = MCP_SIGN_IN_CONNECTED_ACCOUNT_DESCRIPTOR;
    const mode = descriptor.authentication.modes.find(mode => mode.id === 'oauth');
    if (!mode || mode.kind !== 'oauthAuthorizationCode') throw new Error('Expected host MCP OAuth mode');
    let configurationValues: Record<string, unknown> = {};
    const described = { status: 'described', service, descriptor, occurrenceId: 'host-generation', sourceCustody: { kind: 'host' },
      accounts: signOut ? [{ ref: { service, accountId: 'server-id' }, status: 'connected', authenticationModeId: 'oauth',
        configurationReady: true, configurationRevision: 'config-1', scopes: [], revisionSemantics: 'revisioned',
        credentialRevision: 'csr_1234567890123456789012' }] : [], operationTransport: { kind: 'v4' } };
    terminal.rpc.mockResolvedValue(described);
    const host: ConnectedServiceConfigurationActionHostV1 = { assertCurrent() {}, async request() { throw new Error('Unexpected HTTP'); },
      async mutatePurposeBindings() {}, async resolveAgent() { return null; }, async resetQuota() {},
      async authenticationCommand(machineId, command) {
        commands.push({ machineId, command });
        if (command.operation === 'beginConnect') return { status: 'configurationRequired', attemptId: 'attempt',
          target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, missingFieldIds: ['serverId', 'resource'] };
        if (command.operation === 'continueConnect') return { status: 'starting', attemptId: 'attempt' };
        if (command.operation === 'read' && command.waitForProviderStart) return { status: 'awaitingOAuth', attemptId: 'attempt',
          authorizationUrl: 'https://issuer.example.test/authorize?state=attempt.nonce', callbackUrl: mode.callbackUrl, expiresAtMs: 5000 };
        if (command.operation === 'completeOAuth') return { status: 'connected', attemptId: 'attempt', account: { service, accountId: 'server-id' } };
        if (command.operation === 'cancel') return { status: 'cancelled', attemptId: 'attempt' };
        throw new Error('Unexpected authentication');
      },
      async controlCommand(machineId, command) {
        if (command.operation === 'readConfiguration' || command.operation === 'replaceConfiguration') {
          if (command.operation === 'replaceConfiguration') configurationValues = { ...command.values };
          return { status: command.operation === 'readConfiguration' ? 'configuration' : 'configurationCommitted',
            target: { kind: 'attempt', attemptId: 'attempt', service, modeId: 'oauth' }, mode,
            occurrenceId: described.occurrenceId, sourceCustody: described.sourceCustody,
            configuration: { status: 'ready', revision: command.operation === 'readConfiguration' ? null : 'config-1',
              values: configurationValues, configuredSecretFieldIds: [], missingFieldIds: [] } };
        }
        if (command.operation === 'revokeAccount') {
          commands.push({ machineId, command });
          return { status: 'revoked', account: command.account, remoteStatus: 'remoteUnsupported' };
        }
        return described;
      },
    };
    const connectedServiceAction = Object.assign(({ actionId, input }: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['connectedServiceAction']>>[0]) =>
      executeConnectedServiceConfigurationActionV1(host, actionId, input), {
      prepareInput: async (request: Parameters<NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['connectedServiceAction']>>[0]) =>
        request.actionId === 'connectedServices.accounts.revoke' ? await prepareConnectedServiceRevokeInputV1(host, request.input) : request.input,
    });
    const mcpServerAction = createMcpServerActionExecuteV1({
      readCatalog: () => loadMcpServerCatalogV1({ mode: 'plain', material: null, readRow: async () => ({ status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, bindings: [], servers: [{ id: 'server-id', name: 'linear', transport: 'http',
          remote: { url: 'https://resource.example.test/mcp', headers: {}, auth: { kind: 'oauth' } }, env: {}, createdAt: 1, updatedAt: 1 }] } } }) }),
      async mutate() { throw new Error('Unexpected catalog write'); }, async machine() { throw new Error('Unexpected MCP test'); },
      resolveAdministrationMachine: async () => 'machine', describeConnectedService: async () => described, connectedServiceAction,
    });
    const executor = createActionExecutor({ mcpServerAction, connectedServiceAction,
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, { v: 1,
        approvalWaivedSurfaces: { 'mcp.servers.signIn.start': ['cli'],
          'connectedServices.authentication.completeOAuth': ['cli'], 'connectedServices.authentication.cancel': ['cli'],
          'connectedServices.accounts.revoke': ['cli'] } }, context) });
    terminal.prompt.mockResolvedValue('https://app.happier.dev/oauth/mcp/callback?code=returned-code&state=attempt.nonce&iss=https%3A%2F%2Fissuer.example.test');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let credentialReads = 0;
    const handled = await tryHandleMcpServerCliCommand({ argv,
      actionExecutionDeps: { readCredentialsFn: async () => ({ token: switched && credentialReads++ > 0 ? 'another-account-token' : 'test-token', encryption: null }),
        createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected session'); } }) } });
    expect(handled).toBe(true);
    if (switched) {
      expect(commands).not.toContainEqual(expect.objectContaining({ command: expect.objectContaining({ operation: 'beginConnect' }) }));
      expect(process.exitCode).toBe(1);
      return;
    }
    if (signOut) {
      expect(commands).toEqual([{ machineId: 'machine', command: { operation: 'revokeAccount', account: { service, accountId: 'server-id' },
        cleanupGroupReferences: true, expectedCredentialRevision: 'csr_1234567890123456789012' } }]);
      expect(terminal.prompt).not.toHaveBeenCalled();
      return;
    }
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'completeOAuth', attemptId: 'attempt',
      completion: { code: 'returned-code', state: 'attempt.nonce', callbackUrl: mode.callbackUrl, iss: 'https://issuer.example.test' } } });
    expect(configurationValues).toMatchObject({ serverId: 'server-id', resource: 'https://resource.example.test/mcp', stepUp: argv.includes('--step-up') });
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'read', attemptId: 'attempt', waitForProviderStart: true } });
    expect(commands).toContainEqual({ machineId: 'machine', command: { operation: 'cancel', attemptId: 'attempt' } });
    expect(log.mock.calls.some(args => args.some(value => typeof value === 'string' && value.includes('https://issuer.example.test/authorize')))).toBe(true);
  });
});
