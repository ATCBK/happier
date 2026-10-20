import { describe, expect, it } from 'vitest';

import { getActionSpec, listActionSpecsForSurface, listVoiceToolActionSpecs } from './actionSpecs.js';

const coordinationActions = [
  'follow.get', 'follow.set', 'follow.remove', 'follow.list', 'follow.preview',
  'follow.preferences.get', 'follow.preferences.set', 'session.message.reply',
  'session.handoff', 'session.update.post', 'inbox.get', 'inbox.mark_all_read',
  'session.trigger.list', 'workflow.trigger.list', 'workflow.run.list',
  'session.read_state.set', 'session.attention.set',
  'session.manager.set',
  'doc.read', 'doc.comment.reply', 'doc.edit.propose',
] as const;

describe('Coordination Action tool projections', () => {
  it.each(coordinationActions)('registers %s through the canonical Voice and MCP catalogs', actionId => {
    const spec = getActionSpec(actionId);
    expect(listVoiceToolActionSpecs()).toContain(spec);
    expect(spec.bindings?.voiceClientToolName).toBe(actionId.replaceAll('.', '_'));
    expect(listActionSpecsForSurface('mcp')).toContain(spec);
    expect(spec.bindings?.mcpToolName).toBe(actionId.replaceAll('.', '_'));
  });
  it.each(['doc.edit.accept', 'doc.edit.decline'] as const)('keeps %s out of Voice without changing its person floor', actionId => {
    const spec = getActionSpec(actionId);
    expect(listVoiceToolActionSpecs()).not.toContain(spec);
    expect(spec.requiredAuthority).toBe('present_user');
  });
});
