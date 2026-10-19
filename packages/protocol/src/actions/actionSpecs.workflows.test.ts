import { expect, it } from 'vitest';
import { getActionSpec, listVoiceToolActionSpecs } from './actionSpecs.js';

it('projects every workflow start through Voice with the ordinary start approval and strict input', () => {
  const spec = getActionSpec('workflow.run.start');
  expect(listVoiceToolActionSpecs().find(candidate => candidate.id === spec.id)).toBe(spec);
  expect(spec.bindings?.voiceClientToolName).toBe('workflow_run_start');
  expect(spec.safety).toBe('safe');
  expect(spec.approval).toEqual({ result: 'optional', flow: 'deferred' });
  expect(spec.inputSchema.safeParse(JSON.parse(spec.examples!.voice!.argsExample!)).success).toBe(true);
});
