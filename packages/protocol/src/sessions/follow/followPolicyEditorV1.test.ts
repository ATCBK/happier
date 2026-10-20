import { describe, expect, it } from 'vitest';
import * as follow from './index.js';
import * as triggers from '../../automations/automationTriggerDefinition.js';

describe('shared Follow policy editor', () => {
  it('preserves real Habit-only choices while exposing only the supported Follow subset', () => {
    const choices = triggers.projectFollowEventConditionPickerV1({ usage: 'follow', supportedFollowEvents: ['finished', 'needs_you'] });
    expect(choices.map(choice => choice.condition.kind)).toEqual(['needs_you', 'finished']);
    expect(choices.find(choice => choice.condition.kind === 'finished')?.personalEvents).toEqual(['ready']);
    const habits = triggers.projectFollowEventConditionPickerV1({ usage: 'habit' });
    expect(habits.map(choice => choice.condition.kind)).toEqual(expect.arrayContaining(['schedule', 'pluginEvent', 'sessionStarted', 'sessionArchived', 'runLifecycle']));
    expect(habits.find(choice => choice.condition.kind === 'failed_or_stopped')?.lifecycleEvents)
      .toEqual(['parentTurnFailed', 'parentTurnCancelled']);
  });

  it('edits presets and Custom through the one delivery owner without losing unedited choices or Voice', () => {
    const important = { preset: 'important', voice: true } as const;
    const custom = follow.editFollowPolicyV1(important, { kind: 'event', event: { kind: 'needs_you', type: 'decision' }, delivery: 'off' });
    const model = follow.projectFollowPolicyEditorV1(custom);
    expect(model.preset).toBe('custom');
    expect(model.events.find(row => row.event.kind === 'finished')).toMatchObject({ delivery: 'quiet', voice: true });
    expect(model.events.find(row => row.event.kind === 'needs_you' && row.event.type === 'decision')).toMatchObject({ delivery: 'off' });
    expect(model.events.find(row => row.event.kind === 'needs_you' && row.event.type === 'approval')).toMatchObject({ delivery: 'interrupt', voice: true });
    expect(important).toEqual({ preset: 'important', voice: true });
    expect(follow.editFollowPolicyV1(custom, { kind: 'preset', preset: 'quiet' })).toEqual({ preset: 'quiet', voice: true });
  });
});
