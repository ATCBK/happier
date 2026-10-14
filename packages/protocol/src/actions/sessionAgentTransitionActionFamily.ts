import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionAgentTransitionRequestV1Schema, SessionAgentTransitionSelectionV1Schema,
  SessionAgentTransitionResultV1Schema, SessionContinuationInspectionV1Schema } from '../sessions/agentTransition.js';
import type { PreNormalizedActionSpec } from './actionSpecs.js';

export const SESSION_AGENT_TRANSITION_ACTION_IDS = ['session.continuation.inspect', 'session.agent.transition'] as const;
export type SessionAgentTransitionActionId = typeof SESSION_AGENT_TRANSITION_ACTION_IDS[number];
export const SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS = {
  'session.continuation.inspect': lazyZodSchema(() => z.object({
    sessionId: z.string().trim().min(1), selection: SessionAgentTransitionSelectionV1Schema,
  }).strict()),
  'session.agent.transition': lazyZodSchema(() => SessionAgentTransitionRequestV1Schema.omit({ v: true }).strict()),
} as const;
export const SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS = {
  'session.continuation.inspect': lazyZodSchema(() => z.discriminatedUnion('status', [
    z.object({ status: z.literal('answered'), inspection: SessionContinuationInspectionV1Schema }).strict(),
    z.object({ status: z.literal('indeterminate') }).strict(),
  ])),
  'session.agent.transition': SessionAgentTransitionResultV1Schema,
} as const;
const common = {
  requiredAuthority: 'account_automation', executionPlacement: 'session', placements: [],
  originalExecution: { accountRoot: 'allowed' },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
  approval: { result: 'required' },
} as const;
export const SESSION_AGENT_TRANSITION_ACTION_SPECS = [
  { ...common, id: 'session.continuation.inspect', title: 'Inspect Agent continuation',
    description: 'Inspect one exact Agent selection for this Session through the hosting machine. Eligibility grants no mutation authority; switching rechecks it.',
    safety: 'safe', sideEffectClass: 'read', bindings: { mcpToolName: 'session_continuation_inspect' },
    inputSchema: SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS['session.continuation.inspect'],
    outputSchema: SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS['session.continuation.inspect'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'selection', title: 'Exact target Agent selection', widget: 'json', required: true }] },
  },
  { ...common, id: 'session.agent.transition', title: 'Switch Session Agent',
    description: 'Continue the same Session with the exact target Agent and first input. Retain localId and the entire input on retry. Rejected, partial and indeterminate outcomes retain their canonical effect facts.',
    safety: 'danger', sideEffectClass: 'danger', bindings: { mcpToolName: 'session_agent_transition' },
    inputSchema: SESSION_AGENT_TRANSITION_ACTION_INPUT_SCHEMAS['session.agent.transition'],
    outputSchema: SESSION_AGENT_TRANSITION_ACTION_OUTPUT_SCHEMAS['session.agent.transition'],
    inputHints: { fields: [{ path: 'sessionId', title: 'Session id', widget: 'text', required: true },
      { path: 'expectedCurrentAgentId', title: 'Expected current Agent', widget: 'text', required: true },
      { path: 'selection', title: 'Exact target Agent selection', widget: 'json', required: true },
      { path: 'input', title: 'Exact first input and retained localId', widget: 'json', required: true }] },
  },
] as const satisfies readonly PreNormalizedActionSpec[];
