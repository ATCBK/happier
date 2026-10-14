import { z } from 'zod';
import { readRecord } from '../../inputs/inputRecords.js';
import { SKILL_ACTION_INPUT_SCHEMAS_V1 as inputs, SKILL_ACTION_OUTPUT_SCHEMAS_V1 as outputs, type SkillLibraryActionIdV1, type SkillFileInputV1 } from '../../prompts/library/skills/skillActionSchemasV1.js';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 as machineInputs, SKILL_MACHINE_ACTION_OUTPUT_SCHEMAS_V1 as machineOutputs,
  type SkillMachineActionIdV1 } from '../../prompts/library/skills/skillActionSchemasV1.js';
import { AgentIdV1Schema } from '../../agents/agentIdV1.js';
import { SkillReadInputV1Schema, SkillReadResultV1Schema } from '../../prompts/library/skills/skillReadV1.js';
import { decodeBase64 } from '../../crypto/base64.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

/** The deciding user reads file contents; ordinary observations retain only identity. */
function reviewSkillFile(file: SkillFileInputV1) {
  const bytes = decodeBase64(file.contentBase64);
  return { path: file.path, contentKind: file.contentKind, sizeBytes: bytes.byteLength,
    ...(file.unixMode === undefined ? {} : { unixMode: file.unixMode }),
    ...(file.contentKind === 'utf8' ? { content: new TextDecoder().decode(bytes) } : {}) };
}

function projectSkillApprovalInput(id: SkillLibraryActionIdV1, raw: unknown) {
  if (id === 'skills.create') {
    const input = inputs[id].parse(raw);
    return { ...input, files: input.files.map(reviewSkillFile) };
  }
  if (id === 'skills.update') {
    const input = inputs[id].parse(raw);
    return { ...input, ...(input.files ? { files: input.files.map(change => change.kind === 'upsert'
      ? { ...change, file: reviewSkillFile(change.file) } : change) } : {}) };
  }
  if (id === 'skills.install') {
    const input = inputs[id].parse(raw);
    return { ...input, source: input.source.kind === 'upload'
      ? { ...input.source, files: input.source.files.map(reviewSkillFile) } : input.source };
  }
  return inputs[id].parse(raw);
}

function skillSpec<TId extends SkillLibraryActionIdV1>(id: TId, title: string, read = false): PreNormalizedActionSpec & Readonly<{ id: TId; inputSchema: (typeof inputs)[TId]; outputSchema: (typeof outputs)[TId] }> {
  const project = (raw: unknown) => { const input = readRecord(raw); return {
    ...(typeof input.skillId === 'string' ? { skillId: input.skillId } : {}), ...(typeof input.revision === 'string' ? { revision: input.revision } : {}),
    ...(typeof input.ok === 'boolean' ? { ok: input.ok } : {}), ...(typeof input.incomplete === 'string' ? { incomplete: input.incomplete } : {}),
  }; };
  return { id, title, approval: { result: read ? 'none' : 'required' }, approvalPolicy: id === 'skills.delete' ? { uiConfirmation: 'policy' } : {},
    safety: read ? 'safe' : 'danger', sideEffectClass: read ? 'read' : 'write', requiredAuthority: 'account_automation', executionPlacement: 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') }, inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { fields: [] },
    projectObservationInput: project, projectObservationOutput: project,
    approvalPresentation: { summary: () => null, projectInput: raw => projectSkillApprovalInput(id, raw) },
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] } };
}
const itemCli = z.object({ itemId: z.string().min(1), from: z.string().optional(), expectedRevision: z.string().optional(),
  keepMine: z.array(z.string()).optional(), takeTheirs: z.array(z.string()).optional() }).strict();
function itemCliBinding(raw: unknown) { const input = itemCli.parse(raw); return { skillId: input.itemId,
  ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}) }; }
function identityCliBinding(raw: unknown) { return { skillId: itemCli.parse(raw).itemId }; }

function machineSkillSpec<TId extends Exclude<SkillMachineActionIdV1, 'skills.found.list'>>(id: TId, title: string): PreNormalizedActionSpec & Readonly<{
  id: TId; inputSchema: (typeof machineInputs)[TId]; outputSchema: (typeof machineOutputs)[TId];
}> {
  return {
    id, title, approval: { result: 'required' },
    approvalPolicy: id === 'skills.machine.uninstall' ? { uiConfirmation: 'policy' } : {},
    safety: 'danger', sideEffectClass: 'write',
    requiredAuthority: 'account_automation', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') },
    inputSchema: machineInputs[id], outputSchema: machineOutputs[id], inputHints: { fields: [] },
  };
}
const machineSkillCliInput = z.object({ itemId: z.string().min(1), machineId: z.string().min(1) }).strict();
const machineInstallCliInput = machineSkillCliInput.extend({ agents: z.array(AgentIdV1Schema).optional() }).strict();
const machineUninstallCliInput = machineSkillCliInput.extend({ force: z.boolean().optional() }).strict();

export const SKILL_ACTION_SPECS_V1 = [
  { id: 'skills.found.list', title: 'Find skills on a machine',
    description: 'Read native skill folders discovered by the machine’s agent contributions.',
    approval: { result: 'none' }, approvalPolicy: {}, safety: 'safe', sideEffectClass: 'read',
    requiredAuthority: 'account_automation', executionPlacement: 'machine', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: 'skills.found.list', mcpToolName: 'skills_found_list' },
    inputSchema: machineInputs['skills.found.list'], outputSchema: machineOutputs['skills.found.list'], inputHints: { fields: [] },
    cli: { acceptsServerId: true, flagAliases: [{ path: 'machineId', aliases: ['--machine'] }, { path: 'directory', aliases: ['--dir'] }],
      commands: [{ path: ['skills', 'found', 'list'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.found.read', 'Read a skill found on a machine', true), cli: { acceptsServerId: true,
    inputSchema: z.object({ itemId: z.string().min(1), machineId: z.string().min(1) }).strict(),
    bindInput: (raw: unknown) => { const input = readRecord(raw); return { machineId: input.machineId, path: input.itemId }; },
    flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
    commands: [{ path: ['skills', 'found', 'show'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.found.adopt', 'Add found skills to the library'), cli: { acceptsServerId: true,
    inputSchema: z.object({ names: z.array(z.string().min(1)).min(1), machineId: z.string().min(1), off: z.boolean().optional() }).strict(),
    bindInput: (raw: unknown) => { const input = readRecord(raw); return { machineId: input.machineId, items: [],
      ...(input.off ? { where: { kind: 'replace', rules: [] } } : {}) }; },
    flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
    commands: [{ path: ['skills', 'adopt'], variadicPositional: 'names', visibility: 'canonical' }] } },
  { ...machineSkillSpec('skills.machine.install', 'Also install a skill on a machine'),
    description: 'Copy a library skill into the agents’ native user folders for use outside Happier.',
    cli: { acceptsServerId: true, inputSchema: machineInstallCliInput,
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }, { path: 'agents', aliases: ['--agent'] }],
      bindInput: (raw: unknown) => { const input = machineInstallCliInput.parse(raw); return {
        skillId: input.itemId, machineId: input.machineId, ...(input.agents === undefined ? {} : { agents: input.agents }),
      }; },
      commands: [{ path: ['skills', 'machine-install'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...machineSkillSpec('skills.machine.uninstall', 'Remove a skill from a machine'),
    description: 'Remove only this library skill’s receipted installs from the machine.',
    cli: { acceptsServerId: true, inputSchema: machineUninstallCliInput,
      flagAliases: [{ path: 'machineId', aliases: ['--machine'] }],
      bindInput: (raw: unknown) => { const input = machineUninstallCliInput.parse(raw); return {
        skillId: input.itemId, machineId: input.machineId, ...(input.force === undefined ? {} : { force: input.force }),
      }; },
      commands: [{ path: ['skills', 'machine-uninstall'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.list', 'List skills', true), cli: { acceptsServerId: true,
    inputSchema: z.object({ query: z.string().optional(), state: z.enum(['in-use', 'off', 'updates', 'attention']).optional() }).strict(),
    bindInput: (raw: unknown) => { const input = readRecord(raw); return { ...input, ...(input.state ? { state: input.state === 'in-use' ? 'in_use' : input.state === 'attention' ? 'needs_attention' : input.state } : {}) }; },
    commands: [{ path: ['skills', 'list'], visibility: 'canonical' as const }] } },
  { id: 'skills.read', title: 'Read a skill', description: 'Read a library skill and its supporting files. By name, read only a skill delivered to the selected session.',
    approval: { result: 'none' }, approvalPolicy: {}, safety: 'safe', sideEffectClass: 'read', requiredAuthority: 'account_automation', executionPlacement: 'account', executionPlacements: ['account', 'session'],
    executionPlacementForInput: (raw: unknown) => SkillReadInputV1Schema.parse(raw).sessionId ? 'session' : 'account', placements: [],
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false }, bindings: { rpcMethod: 'skills.read', mcpToolName: 'skills_read' },
    toolExposure: { agent: 'direct', mcp: 'direct', cli: 'direct' }, inputSchema: SkillReadInputV1Schema, outputSchema: SkillReadResultV1Schema, inputHints: { fields: [] },
    cli: { acceptsServerId: true, inputSchema: z.object({ itemId: z.string(), file: z.string().optional() }).strict(),
      bindInput: (raw: unknown) => { const input = readRecord(raw); return { skillId: input.itemId, ...(input.file ? { file: input.file } : {}) }; },
      commands: [{ path: ['skills', 'show'], positionals: ['itemId'], visibility: 'canonical' }, { path: ['skills', 'read'], visibility: 'alias' }] } },
  { ...skillSpec('skills.create', 'Create a skill'), cli: { acceptsServerId: true,
    inputSchema: z.object({ name: z.string(), from: z.string(), off: z.boolean().optional() }).strict(),
    bindInput: (raw: unknown) => { const input = readRecord(raw); return { name: input.name, files: [], ...(input.off ? { where: { kind: 'replace', rules: [] } } : {}) }; },
    commands: [{ path: ['skills', 'create'], positionals: ['name'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.update', 'Update a skill'), cli: { acceptsServerId: true, inputSchema: itemCli,
    bindInput: (raw: unknown, ctx) => ({ ...itemCliBinding(raw), ...(ctx.commandPath?.at(-1) === 'auto' ? { updatePolicy: 'auto' }
      : ctx.commandPath?.at(-1) === 'pin' ? { updatePolicy: 'pinned' } : ctx.commandPath?.at(-1) === 'unpin' ? { updatePolicy: 'manual' } : {}) }),
    commands: [{ path: ['skills', 'update'], visibility: 'canonical' }, ...(['edit', 'auto', 'pin', 'unpin'] as const).map(leaf => ({ path: ['skills', leaf], positionals: ['itemId'], visibility: 'canonical' as const }))] } },
  { ...skillSpec('skills.duplicate', 'Duplicate a skill'), cli: { acceptsServerId: true, inputSchema: itemCli, bindInput: identityCliBinding, commands: [{ path: ['skills', 'duplicate'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.delete', 'Delete a skill'), cli: { acceptsServerId: true, inputSchema: itemCli, bindInput: itemCliBinding, commands: [{ path: ['skills', 'delete'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.install', 'Add a skill'), cli: { acceptsServerId: true,
    inputSchema: z.object({ source: z.string(), path: z.array(z.string()).optional(), dryRun: z.boolean().optional(), off: z.boolean().optional() }).strict(),
    bindInput: (raw: unknown) => { const input = readRecord(raw); return { source: { kind: 'link', url: input.source },
      ...(input.path ? { selectPaths: input.path } : {}), ...(input.dryRun ? { dryRun: true } : {}), ...(input.off ? { where: { kind: 'replace', rules: [] } } : {}) }; },
    commands: [{ path: ['skills', 'install'], positionals: ['source'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.export', 'Export skills', true), cli: { acceptsServerId: true,
    inputSchema: z.object({ names: z.array(z.string()).min(1), out: z.string() }).strict(), bindInput: (raw: unknown) => ({ skillIds: readRecord(raw).names }),
    commands: [{ path: ['skills', 'export'], variadicPositional: 'names', visibility: 'canonical' }] } },
  { ...skillSpec('skills.updates.diff', 'Review a skill update', true), cli: { acceptsServerId: true, inputSchema: itemCli, bindInput: identityCliBinding,
    commands: [{ path: ['skills', 'updates', 'diff'], positionals: ['itemId'], visibility: 'canonical' }] } },
  { ...skillSpec('skills.updates.apply', 'Apply a skill update'), cli: { acceptsServerId: true, inputSchema: itemCli, bindInput: (raw: unknown) => {
    const input = itemCli.parse(raw); return { ...itemCliBinding(raw), choices: Object.fromEntries([...(input.keepMine ?? []).map(path => [path, 'mine']), ...(input.takeTheirs ?? []).map(path => [path, 'theirs'])]) }; },
    commands: [{ path: ['skills', 'updates', 'apply'], positionals: ['itemId'], visibility: 'canonical' }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
