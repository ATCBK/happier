import { SkillReadInputV1Schema, SkillReadResultV1Schema } from '../../prompts/library/skills/skillReadV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

export const SKILL_READ_ACTION_SPECS_V1 = [{
  id: 'skills.read', title: 'Read a skill', description: 'Read a library skill and its supporting files. By name, read only a skill delivered to the selected session.',
  approval: { result: 'none' }, approvalPolicy: {}, safety: 'safe', sideEffectClass: 'read',
  requiredAuthority: 'account_automation', executionPlacement: 'account',
  executionPlacementForInput: (input: unknown) => SkillReadInputV1Schema.parse(input).sessionId ? 'session' : 'account',
  placements: [], surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
  bindings: { rpcMethod: 'skills.read', mcpToolName: 'skills_read' },
  toolExposure: { agent: 'direct', mcp: 'direct', cli: 'direct' },
  inputSchema: SkillReadInputV1Schema, outputSchema: SkillReadResultV1Schema,
  inputHints: { fields: [] },
  cli: { acceptsServerId: true, commands: [{ path: ['skills', 'read'], visibility: 'canonical' }] },
} as const] satisfies readonly PreNormalizedActionSpec[];
