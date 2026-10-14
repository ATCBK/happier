import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { CapabilityApplyTimingV1Schema } from '../../reach/capabilityApplyTimingV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';
import { DetectedMcpPreviewEntryV1Schema, ManagedMcpPreviewEntryV1Schema } from '../../mcp/servers/previewV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { SessionSkillPlanV1Schema } from '../../prompts/library/skills/resolveSessionSkillPlanV1.js';

const identity = lazyZodSchema(() => z.string().trim().min(1));
export const CapabilityItemStateV1Schema = lazyZodSchema(() => z.object({
  kind: z.enum(['mcp_server', 'skill']), id: identity, name: identity, title: identity.optional(),
  selected: z.boolean(), selectable: z.boolean(),
  reason: z.enum(['rule_on', 'rule_off', 'no_rule', 'session_added', 'session_removed', 'managed_off', 'not_portable', 'agent_unsupported']),
  decidedBy: z.object({ ruleId: identity, target: z.enum(['allMachines', 'machine', 'project', 'workspace']), agentQualified: z.boolean() }).strict().nullable(),
  sessionOverride: z.enum(['added', 'removed']).nullable(),
}).strict());
export const CapabilityMcpPreviewItemV1Schema = lazyZodSchema(() => CapabilityItemStateV1Schema.extend({
  kind: z.literal('mcp_server'), source: z.enum(['catalog', 'plugin']),
  preview: ManagedMcpPreviewEntryV1Schema.optional(),
}).strict());
export const CapabilitySkillPreviewItemV1Schema = lazyZodSchema(() => CapabilityItemStateV1Schema.extend({
  kind: z.literal('skill'), state: z.enum(['delivered', 'masked_by_native', 'off', 'excluded', 'name_conflict', 'unavailable']).optional(),
}).strict());
export const CapabilityApplyTimingPairV1Schema = lazyZodSchema(() => z.object({
  mcp: CapabilityApplyTimingV1Schema, skills: CapabilityApplyTimingV1Schema,
}).strict());
const skillsOutput = lazyZodSchema(() => z.object({ items: z.array(CapabilitySkillPreviewItemV1Schema), plan: SessionSkillPlanV1Schema }).strict());
export const SpawnCapabilitiesPreviewInputV1Schema = lazyZodSchema(() => z.object({
  machineId: identity, directory: identity.optional(), agentId: identity, projectKey: identity.optional(), profileId: identity.optional(),
  capabilitySelection: SessionCapabilitySelectionAuthoringV1Schema.optional(),
}).strict());
export type SpawnCapabilitiesPreviewInputV1 = z.infer<typeof SpawnCapabilitiesPreviewInputV1Schema>;
export const SpawnCapabilitiesPreviewSuccessV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true), machinePlatform: z.enum(['win32', 'posix']).nullable(),
  mcp: z.object({ strictMode: z.boolean(), items: z.array(CapabilityMcpPreviewItemV1Schema), detected: z.array(DetectedMcpPreviewEntryV1Schema) }).strict(),
  skills: skillsOutput, applyTiming: CapabilityApplyTimingPairV1Schema,
}).strict());
export const SpawnCapabilitiesPreviewOutputV1Schema = lazyZodSchema(() => z.union([
  SpawnCapabilitiesPreviewSuccessV1Schema,
  z.object({ ok: z.literal(false), reason: z.enum(['machine_unreachable', 'invalid_input']) }).strict(),
]));
export type SpawnCapabilitiesPreviewOutputV1 = z.infer<typeof SpawnCapabilitiesPreviewOutputV1Schema>;
export const SessionCapabilitiesGetInputV1Schema = lazyZodSchema(() => z.object({ sessionId: identity }).strict());
export type SessionCapabilitiesGetInputV1 = z.infer<typeof SessionCapabilitiesGetInputV1Schema>;
export const SessionCapabilitiesGetOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), mcp: z.object({ items: z.array(CapabilityMcpPreviewItemV1Schema) }).strict(), skills: skillsOutput,
    pendingApply: z.object({ mcp: z.boolean(), skills: z.boolean(), reason: z.string().optional(), restartBy: z.enum(['user', 'terminal']).optional() }).strict(),
    applyTiming: CapabilityApplyTimingPairV1Schema,
  }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['not_found', 'session_unavailable']) }).strict(),
]));
export type SessionCapabilitiesGetOutputV1 = z.infer<typeof SessionCapabilitiesGetOutputV1Schema>;
export const SessionCapabilitiesSetInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: identity, kind: z.enum(['skill', 'mcp_server', 'native_skill']), id: identity,
  state: z.enum(['on', 'off', 'inherit']), reason: z.string().optional(),
}).strict());
export type SessionCapabilitiesSetInputV1 = z.infer<typeof SessionCapabilitiesSetInputV1Schema>;
export const SessionCapabilitiesSetOutputV1Schema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), state: z.enum(['on', 'off', 'inherit']), previous: z.enum(['on', 'off', 'inherit']),
    applyTiming: z.union([CapabilityApplyTimingV1Schema.options[0], CapabilityApplyTimingV1Schema.options[1],
      CapabilityApplyTimingV1Schema.options[3], CapabilityApplyTimingV1Schema.options[4]]),
  }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(['applies_to_new_sessions_only', 'not_found', 'session_unavailable', 'conflict']) }).strict(),
]));
export type SessionCapabilitiesSetOutputV1 = z.infer<typeof SessionCapabilitiesSetOutputV1Schema>;

const sessionCliInput = lazyZodSchema(() => z.object({ sessionId: identity, kind: z.enum(['skill', 'mcp_server', 'native_skill']), id: identity,
  reason: z.string().optional() }).strict());
const common = { placements: [], requiredAuthority: 'account_automation',
  surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false }, approval: { result: 'required' },
} as const;
export const SESSION_CAPABILITIES_ACTION_SPECS_V1 = [
  { ...common, id: 'sessions.spawn.capabilities.preview', title: 'Preview session capabilities', safety: 'safe', sideEffectClass: 'read',
    executionPlacement: 'machine', surfaces: { ...common.surfaces, voice: true },
    bindings: { mcpToolName: 'sessions_spawn_capabilities_preview', rpcMethod: 'sessions.spawn.capabilities.preview',
      voiceClientToolName: 'previewSpawnCapabilities' },
    examples: { voice: { argsExample: '{"machineId":"{{machineId}}","agentId":"codex","directory":"{{path}}"}' } },
    inputSchema: SpawnCapabilitiesPreviewInputV1Schema, outputSchema: SpawnCapabilitiesPreviewOutputV1Schema,
    inputHints: { fields: [{ path: 'machineId', title: 'Machine', widget: 'text', required: true },
      { path: 'agentId', title: 'Agent', widget: 'text', required: true }, { path: 'directory', title: 'Directory', widget: 'text' }] },
    cli: { commands: [{ path: ['session', 'preview'], visibility: 'canonical' }],
      flagAliases: [{ path: 'directory', aliases: ['--dir'] }, { path: 'machineId', aliases: ['--machine'] },
        { path: 'agentId', aliases: ['--agent'] }, { path: 'projectKey', aliases: ['--project'] }] },
  },
  { ...common, id: 'session.capabilities.get', title: 'List session capabilities', safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account',
    bindings: { mcpToolName: 'session_capabilities_get', rpcMethod: 'session.capabilities.get' },
    inputSchema: SessionCapabilitiesGetInputV1Schema, outputSchema: SessionCapabilitiesGetOutputV1Schema,
    inputHints: { fields: [{ path: 'sessionId', title: 'Session', widget: 'text', required: true }] },
    cli: { commands: [{ path: ['session', 'capabilities'], positionals: ['sessionId'], visibility: 'canonical' },
      { path: ['session', 'capabilities', 'list'], positionalsBeforeLastSegment: ['sessionId'], visibility: 'canonical' }] },
  },
  { ...common, id: 'session.capabilities.set', title: 'Change session capabilities', safety: 'danger', sideEffectClass: 'write', executionPlacement: 'account',
    approval: { result: 'required', flow: 'deferred' },
    bindings: { mcpToolName: 'session_capabilities_set', rpcMethod: 'session.capabilities.set' },
    inputSchema: SessionCapabilitiesSetInputV1Schema, outputSchema: SessionCapabilitiesSetOutputV1Schema,
    inputHints: { fields: [{ path: 'sessionId', title: 'Session', widget: 'text', required: true },
      { path: 'kind', title: 'Kind', widget: 'text', required: true }, { path: 'id', title: 'Item', widget: 'text', required: true },
      { path: 'state', title: 'State', widget: 'text', required: true }, { path: 'reason', title: 'Reason', widget: 'textarea' }] },
    cli: { commands: (['add', 'remove', 'reset'] as const).map(leaf => ({ path: ['session', 'capabilities', leaf],
      positionalsBeforeLastSegment: ['sessionId'], positionals: ['kind', 'id'], visibility: 'canonical' as const })), inputSchema: sessionCliInput,
      bindInput: (raw, context) => { const input = sessionCliInput.parse(raw), leaf = context.commandPath?.at(-1);
        return { ...input, state: leaf === 'add' ? 'on' : leaf === 'remove' ? 'off' : 'inherit' }; },
    },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
