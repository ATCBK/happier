import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineResourcesPolicyMutationV1Schema, MachineResourcesPolicyGetResultV1Schema, MachineResourcesPolicyMutationResultV1Schema } from '../../machines/resources/machineResourcesPolicyV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const MACHINE_RESOURCES_ACTION_IDS = ['machines.resources.policy.get', 'machines.resources.policy.set'] as const;
export type MachineResourcesActionId = typeof MACHINE_RESOURCES_ACTION_IDS[number];
export const MachineResourcesActionIdSchema = lazyZodSchema(() => z.enum(MACHINE_RESOURCES_ACTION_IDS));
export const MachineResourcesPolicyGetInputV1Schema = lazyZodSchema(() => z.object({ serverId: z.string().trim().min(1).optional(), machineId: z.string().trim().min(1) }).strict());
export const MachineResourcesPolicySetInputV1Schema = lazyZodSchema(() => MachineResourcesPolicyGetInputV1Schema.extend(MachineResourcesPolicyMutationV1Schema.shape).strict());
const policySetCliFields = lazyZodSchema(() => MachineResourcesPolicySetInputV1Schema.extend({
  patch: MachineResourcesPolicyMutationV1Schema.shape.patch.optional(), allProcessesVisible: z.boolean().optional(),
}).strict());
export const MachineResourcesPolicySetCliInputV1Schema = lazyZodSchema(() => policySetCliFields.refine(
  input => (input.patch === undefined) !== (input.allProcessesVisible === undefined),
  'Supply either a policy patch or the All processes choice',
));
export function bindMachineResourcesPolicySetCliInput(value: unknown): unknown {
  // The compiler may combine these caller flags with canonical whole-input JSON.
  const { allProcessesVisible, ...input } = policySetCliFields.partial().parse(value);
  return allProcessesVisible === undefined ? input : { ...input, patch: { processes: { allProcessesVisible } } };
}
export const MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS = {
  'machines.resources.policy.get': MachineResourcesPolicyGetInputV1Schema,
  'machines.resources.policy.set': MachineResourcesPolicySetInputV1Schema,
} as const;
export type MachineResourcesActionInput = z.infer<(typeof MACHINE_RESOURCES_ACTION_INPUT_SCHEMAS)[MachineResourcesActionId]>;
const fields = [{ path: 'serverId', title: 'Home ID', widget: 'text', required: false },
  { path: 'machineId', title: 'Machine ID', widget: 'text', required: true }] as const;
const surfaces = { ui: true, cli: true, agent: true, mcp: true, voice: true, rpc: false } as const;
export const MACHINE_RESOURCES_ACTION_SPECS = [
  {
    id: 'machines.resources.policy.get', approval: {result: 'required'}, title: 'Read resource settings',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read the synced policy and its revision before suggesting a change. The policy remains readable offline; writing requires the target daemon.' },
    description: 'A machine’s alerts, guard and cleanup settings, also while it is offline.',
    safety: 'safe', sideEffectClass: 'read', executionPlacement: 'account', placements: [], surfaces,
    bindings: { mcpToolName: 'machines_resources_policy_get', voiceClientToolName: 'getMachineResourcesPolicy' },
    inputSchema: MachineResourcesPolicyGetInputV1Schema, outputSchema: MachineResourcesPolicyGetResultV1Schema,
    cli: { acceptsServerId: true, commands: [{ path: ['machines', 'resources', 'policy', 'get'], visibility: 'canonical' }] },
    inputHints: { fields },
  },
  {
    id: 'machines.resources.policy.set', approvalPolicy: { agentDefault: 'authority' }, approval: {result: 'required'}, title: 'Change resource settings',
    toolExposure: { agent: 'discoverable_only' },
    prompting: { agentGuidance: 'Read machines.resources.policy.get first, then submit one minimal patch with its expectedRevision. Change only the policy the person asked to change; approval follows this Action’s own user setting.' },
    description: 'Changes a machine’s alerts, guard and cleanup settings. If they changed meanwhile, you see the current ones first.',
    safety: 'safe', sideEffectClass: 'write', executionPlacement: 'machine', placements: [], surfaces: { ...surfaces, voice: false, rpc: true },
    bindings: { mcpToolName: 'machines_resources_policy_set', rpcMethod: RPC_METHODS.MACHINES_RESOURCES_POLICY_SET },
    inputSchema: MachineResourcesPolicySetInputV1Schema, outputSchema: MachineResourcesPolicyMutationResultV1Schema,
    cli: { acceptsServerId: true, commands: [
      { path: ['machines', 'resources', 'policy', 'set'], visibility: 'canonical' },
      { path: ['machines', 'processes', 'all'], visibility: 'alias' },
    ], inputSchema: MachineResourcesPolicySetCliInputV1Schema, bindInput: bindMachineResourcesPolicySetCliInput,
      inputHints: { fields: [...fields,
        { path: 'expectedRevision', title: 'Expected revision', widget: 'number', required: true },
        { path: 'patch', title: 'Policy patch', widget: 'json' },
        { path: 'allProcessesVisible', title: 'Show all processes', widget: 'boolean' },
      ] } },
    inputHints: { fields: [...fields, { path: 'expectedRevision', title: 'Expected revision', widget: 'number', required: true }, { path: 'patch', title: 'Policy patch', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
