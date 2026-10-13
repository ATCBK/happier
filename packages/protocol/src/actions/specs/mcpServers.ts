import { readRecord } from '../../inputs/inputRecords.js';
import { MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 as inputs, MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type McpServerActionIdV1 } from '../../mcp/servers/serverActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { z } from 'zod';

function projectMcpObservation(input: unknown): unknown {
  const value = readRecord(input);
  const entry = readRecord(value.entry);
  return {
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.serverId === 'string' ? { serverId: value.serverId } : typeof entry.id === 'string' ? { serverId: entry.id } : {}),
    ...(Array.isArray(value.entries) ? { serverIds: value.entries
      .map(item => readRecord(readRecord(item).entry).id).filter(id => typeof id === 'string') } : {}),
    ...(typeof value.machineId === 'string' ? { machineId: value.machineId } : {}),
    ...(typeof value.expectedRevision === 'number' || value.expectedRevision === 'absent' ? { expectedRevision: value.expectedRevision } : {}),
    ...(typeof value.revision === 'number' || value.revision === 'absent' ? { revision: value.revision } : {}),
    ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
    ...(typeof value.toolCount === 'number' ? { toolCount: value.toolCount } : {}),
  };
}
function mcpSpec<TId extends McpServerActionIdV1>(id: TId, title: string, summary: string, options: Readonly<{
  read?: boolean; danger?: boolean; machine?: boolean; confirm?: boolean;
}>): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: (typeof inputs)[TId]; outputSchema: (typeof outputs)[TId] }> {
  return {
    id, approvalPolicy: options.confirm ? { uiConfirmation: 'policy' } : {},
    approval: { result: options.danger ? 'required' : 'none' }, title, safety: options.danger ? 'danger' : 'safe', sideEffectClass: options.read ? 'read' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.machine ? 'machine' : 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, voice: false, rpc: true },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { description: summary, fields: [] },
    projectObservationInput: projectMcpObservation, projectObservationOutput: projectMcpObservation,
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  };
}
export const MCP_SERVER_ACTION_SPECS_V1 = [
  { ...mcpSpec('mcp.servers.signIn.start', 'Sign in to MCP server',
    'Sign in once to use this remote server from your machines.', { danger: true }),
    approvalResultCustody: 'live_only' as const,
    cli: { acceptsServerId: true, inputSchema: z.object({ itemId: z.string().min(1), stepUp: z.boolean().optional() }).strict(),
      bindInput: (value: unknown) => { const input = readRecord(value); return { serverId: input.itemId,
        ...(input.stepUp === undefined ? {} : { stepUp: input.stepUp }) }; },
      commands: [{ path: ['mcp', 'servers', 'sign-in'], positionals: ['itemId'], visibility: 'canonical' as const }] } },
  mcpSpec('mcp.servers.list', 'List MCP servers',
    'See the MCP servers saved in your account.', { read: true }),
  mcpSpec('mcp.servers.read', 'Read MCP server',
    'See one MCP server: how it starts and where it is used.', { read: true }),
  { ...mcpSpec('mcp.servers.tools.list', 'List MCP server tools',
    'See the tools checked for a server, their settings and approximate cost.', { read: true }),
    cli: { acceptsServerId: true, inputSchema: z.object({ itemId: z.string().min(1) }).strict(),
      bindInput: (value: unknown) => ({ serverId: readRecord(value).itemId }),
      commands: [{ path: ['mcp', 'servers', 'tools'], positionals: ['itemId'], visibility: 'canonical' as const },
        { path: ['mcp', 'servers', 'tools', 'list'], positionals: ['itemId'], visibility: 'alias' as const }] } },
  { ...mcpSpec('mcp.servers.tools.set', 'Set MCP server tool settings',
    'Change a server default or individual tool settings. The previous settings can be restored.', { danger: true }),
    cli: { acceptsServerId: true, inputSchema: z.object({ itemId: z.string().min(1),
      operation: z.enum(['set', 'default']), toolName: z.string().min(1),
      setting: z.enum(['off', 'ask', 'allow', 'inherit']).optional() }).strict().superRefine((input, context) => {
      if (input.operation === 'set' && input.setting === undefined) {
        context.addIssue({ code: 'custom', path: ['setting'], message: 'Supply a tool setting.' });
      }
      if (input.operation === 'default' && (!['ask', 'read-only', 'all'].includes(input.toolName) || input.setting !== undefined)) {
        context.addIssue({ code: 'custom', path: ['toolName'], message: 'Supply one default: ask, read-only or all.' });
      }
    }),
      bindInput: (value: unknown) => {
        const input = readRecord(value);
        return input.operation === 'set' && typeof input.toolName === 'string'
          ? { serverId: input.itemId, tools: { [input.toolName]: input.setting } }
          : { serverId: input.itemId, default: input.toolName === 'read-only' ? 'allow_read_only'
            : input.toolName === 'all' ? 'allow_all' : input.toolName };
      },
      commands: [{ path: ['mcp', 'servers', 'tools', 'set'], positionals: ['itemId', 'operation', 'toolName', 'setting'],
        visibility: 'canonical' as const }] } },
  mcpSpec('mcp.servers.create', 'Add MCP server',
    'Add an MCP server, which gives agents extra tools.', { danger: true }),
  mcpSpec('mcp.servers.update', 'Update MCP server',
    'Change how an MCP server starts or signs in.', { danger: true }),
  mcpSpec('mcp.servers.duplicate', 'Duplicate MCP server',
    'Make a copy of an MCP server to adjust.', { danger: true }),
  mcpSpec('mcp.servers.delete', 'Delete MCP server',
    'Remove an MCP server. Agents lose its tools everywhere it was used.', { danger: true, confirm: true }),
  { ...mcpSpec('mcp.servers.test', 'Test MCP server connection',
    'Start an MCP server on a machine and check that it answers with its tools.', { danger: true, machine: true }),
    cli: { acceptsServerId: true,
      inputSchema: z.object({ itemId: z.string().min(1), directory: z.string().min(1).optional(),
        machineId: z.string().min(1).optional() }).strict(),
      bindInput: (value: unknown) => { const input = readRecord(value); return { t: 'byId', serverId: input.itemId,
        directory: input.directory, machineId: input.machineId }; },
      commands: [{ path: ['mcp', 'servers', 'test'], positionals: ['itemId'], visibility: 'canonical' as const }] } },
  { ...mcpSpec('mcp.servers.import', 'Import MCP servers',
    'Review a config or install link and choose every named value before adding its servers.', { danger: true }), approvalInputCustody: 'live_only' as const },
  { ...mcpSpec('mcp.found.adopt', 'Add a found MCP server',
    'Add a machine configuration after choosing its environment and header values.', { danger: true }), approvalInputCustody: 'live_only' as const },
  mcpSpec('mcp.found.list', 'Detect MCP servers on a machine',
    'Look for MCP servers already set up for the agents on a machine.', { read: true, machine: true }),
] as const satisfies readonly PreNormalizedActionSpec[];
