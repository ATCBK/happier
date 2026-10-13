import { describe, expect, it } from 'vitest';

import { getActionInputFieldVoiceNotes, getActionVoiceWorkflowNotes } from './actionInputVoiceGuidance.js';
import { ActionInputFieldHintSchema, getActionSpec } from './actionSpecs.js';

function declaredField(actionId: Parameters<typeof getActionSpec>[0], path: string) {
  const field = getActionSpec(actionId).inputHints?.fields.find((field) => field.path === path);
  if (!field) throw new Error(`Missing declared input field: ${actionId}.${path}`);
  return field;
}

describe('actionInputVoiceGuidance', () => {
  it('uses backendTargetKeys in backend-selection guidance', () => {
    const fieldNotes = getActionInputFieldVoiceNotes(
      { id: 'subagents.plan.start' },
      declaredField('subagents.plan.start', 'backendTargetKeys'),
    ).join(' ');
    const workflowNotes = getActionVoiceWorkflowNotes('subagents.plan.start').join(' ');

    expect(fieldNotes).toContain('backendTargetKeys');
    expect(fieldNotes).toContain('provider/backend targets');
    expect(fieldNotes).toContain('not as parallelism capacity');
    expect(fieldNotes).not.toContain('backendIds');
    expect(workflowNotes).toContain('backendTargetKeys');
    expect(workflowNotes).toContain('provider/backend targets');
    expect(workflowNotes).not.toContain('backendIds');
  });

  it('describes canonical backend targets and runtime carrier guidance for agents.models.list', () => {
    const backendTargetKeyNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      declaredField('agents.models.list', 'backendTargetKey'),
    ).join(' ');
    const agentIdNotes = getActionInputFieldVoiceNotes(
      { id: 'agents.models.list' },
      declaredField('agents.models.list', 'agentId'),
    ).join(' ');

    expect(backendTargetKeyNotes).toContain('backend:');
    expect(backendTargetKeyNotes).toContain('acpBackend:');
    expect(agentIdNotes).toContain('listAgentBackends');
  });

  it('guides canonical Session creation fields without reviving flat spawn vocabulary', () => {
    const targetNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'executionTarget.machineId'),
    ).join(' ');
    const directoryNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'directory'),
    ).join(' ');
    const agentNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      declaredField('session.spawn_new', 'agentTarget'),
    ).join(' ');
    const legacyPathNotes = getActionInputFieldVoiceNotes(
      { id: 'session.spawn_new' },
      ActionInputFieldHintSchema.parse({ path: 'path', title: 'Retired path', widget: 'text' }),
    ).join(' ');

    expect(targetNotes).toContain('listMachines');
    expect(directoryNotes).toContain('listRecentPaths');
    expect(agentNotes).toContain('listAgentBackends');
    expect(legacyPathNotes).toBe('');
  });

  it('guides transcript-reading requests to the semantic transcript action', () => {
    const activityNotes = getActionVoiceWorkflowNotes('session.activity.get').join(' ');
    const recentNotes = getActionVoiceWorkflowNotes('session.messages.recent.get').join(' ');
    const transcriptNotes = getActionInputFieldVoiceNotes(
      { id: 'session.transcript.get' },
      declaredField('session.transcript.get', 'sessionId'),
    ).join(' ');

    expect(activityNotes).toContain('getSessionTranscript');
    expect(recentNotes).toContain('getSessionTranscript');
    expect(transcriptNotes).toContain('listSessions');
  });
});
