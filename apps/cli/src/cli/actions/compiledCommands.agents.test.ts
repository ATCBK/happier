import { describe, expect, it } from 'vitest';
import { findCompiledActionCliCommand, listCompiledActionCliCommands } from './compiledCommands';
import { composeActionCliInput, parseActionCliCommandInput } from './parseCommandInput';

describe('Agent commands use the compiled Action owner', () => {
  it.each([
    [['agents', 'install'], ['codex', '--machine', 'machine'], 'machines.agents.install', { agentId: 'codex', machineId: 'machine', intent: 'install' }],
    [['agents', 'update'], ['codex', '--machine', 'machine', '--yes', '--force'], 'machines.agents.install', { agentId: 'codex', machineId: 'machine', intent: 'update', consent: { vendorRecipe: true }, force: true }],
    [['agents', 'remove'], ['custom-acp', '--definition-id', 'goose', '--machine', 'machine'], 'machines.agents.uninstall', { agentId: 'custom-acp', definitionId: 'goose', machineId: 'machine' }],
    [['machines', 'agents', 'list'], ['--machine-id', 'machine', '--agent-id', 'custom-acp', '--definition-id', 'goose'], 'machines.agents.list', { machineId: 'machine', agentId: 'custom-acp', definitionId: 'goose' }],
    [['agents', 'delete'], ['goose'], 'agents.acp.backends.delete', { backendId: 'goose' }],
    [['agents', 'install', 'status'], ['job', '--machine', 'machine'], 'machines.agents.install.status', { jobId: 'job', machineId: 'machine' }],
    [['agents', 'install', 'cancel'], ['job', '--machine', 'machine'], 'machines.agents.install.cancel', { jobId: 'job', machineId: 'machine' }],
    [['agents', 'browse'], ['goose', '--source', 'acp-registry'], 'registries.items.list', { kind: 'agent', query: 'goose', sourceIds: ['builtin:acp-registry'] }],
    [['agents', 'show'], ['acp-registry/goose'], 'registries.items.read', { kind: 'agent', sourceId: 'builtin:acp-registry', itemId: 'goose' }],
    [['agents', 'show'], ['org.agents/catalog/goose'], 'registries.items.read', { kind: 'agent', sourceId: 'org.agents/catalog', itemId: 'goose' }],
    [['agents', 'add'], ['acp-registry/goose', '--version', '1.2.3', '--install', 'first-use'], 'agents.acp.backends.installFromRegistry', { fromRegistry: { sourceId: 'builtin:acp-registry', itemId: 'goose', version: '1.2.3' } }],
    [['agents', 'add'], ['org.agents/catalog/goose', '--version', '1.2.3', '--install', 'first-use'], 'agents.acp.backends.installFromRegistry', { fromRegistry: { sourceId: 'org.agents/catalog', itemId: 'goose', version: '1.2.3' } }],
  ] as const)('binds %j to its strict canonical input', (path, args, actionId, input) => {
    const command = findCompiledActionCliCommand(path, listCompiledActionCliCommands());
    expect(command?.actionId).toBe(actionId);
    if (!command) throw new Error('Expected compiled Agent command');
    const parsed = parseActionCliCommandInput(command, [...path, ...args]);
    if (!parsed.ok) throw new Error(parsed.message);
    const composed = composeActionCliInput({ parsed, canonicalSchema: command.spec.inputSchema,
      wholeInputSchema: command.wholeInputSchema, callerSchema: command.callerSchema, bindInput: command.spec.cli?.bindInput,
      context: { actionId: command.actionId, invocationId: 'agent-cli-test', commandPath: command.path, output: 'json' } });
    expect(composed).toMatchObject({ ok: true, input });
    expect(command.spec.inputSchema.safeParse(input).success).toBe(true);
  });

  it('keeps caller-only flags out of canonical whole input', () => {
    const command = findCompiledActionCliCommand(['agents', 'install'], listCompiledActionCliCommands());
    expect(command).not.toBeNull();
    if (!command) throw new Error('Expected compiled install command');
    expect(command.wholeInputSchema.safeParse({ machineId: 'machine', agentId: 'codex', intent: 'install', yes: true }).success).toBe(false);
    const parsed = parseActionCliCommandInput(command, ['agents', 'install', 'codex', '--bogus']);
    expect(parsed.ok).toBe(false);
  });
});
