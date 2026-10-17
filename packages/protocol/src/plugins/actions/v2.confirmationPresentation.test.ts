import { describe, expect, it } from 'vitest';

import { PluginActionConfirmationV2Schema, PluginActionContributionV2Schema } from './v2.js';
import { pluginActionRequiresPresentUserIntent } from './invocation.js';

describe('PluginActionConfirmationV2Schema', () => {
  it('keeps reversible own-UI confirmation separate from danger, settings and other requesters', () => {
    const action = PluginActionContributionV2Schema.parse({
      id: 'set-complete', title: 'Set completion', execution: { target: 'daemon' },
      scopes: ['global'], surfaces: ['ui', 'agent', 'mcp', 'cli', 'voice'], placementBindings: [],
      dangerLevel: 'writesLocal', confirmation: { title: 'Change completion?' },
      confirmationWhen: { presentUserUi: false },
    });
    expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'present_user')).toBe(false);
    expect(pluginActionRequiresPresentUserIntent(action, 'ui', undefined, 'account_automation')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent(action, 'ui')).toBe(true);
    for (const surface of ['agent', 'mcp', 'cli', 'api', 'voice', '']) {
      expect(pluginActionRequiresPresentUserIntent(action, surface)).toBe(true);
    }
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true }, 'ui', undefined, 'present_user')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, 'agent')).toBe(false);
    const { confirmationWhen: _confirmationWhen, ...defaultAction } = action;
    for (const dangerLevel of ['writesLocal', 'writesRemote', 'externalSideEffect', 'destructive'] as const) {
      expect(pluginActionRequiresPresentUserIntent({ ...defaultAction, dangerLevel }, 'ui')).toBe(true);
    }
    expect(PluginActionContributionV2Schema.safeParse({ ...action,
      confirmationWhen: { presentUserUi: false, nonWaivable: true },
    }).success).toBe(false);
    const predicate = { op: 'eq', path: 'replace', value: true } as const;
    const scoped = { ...action, confirmationWhen: { presentUserUi: predicate } };
    expect(pluginActionRequiresPresentUserIntent(scoped, 'ui', { replace: false }, 'present_user')).toBe(false);
    expect(pluginActionRequiresPresentUserIntent(scoped, 'ui', { replace: true }, 'present_user')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent(scoped, 'ui', undefined, 'present_user')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent(scoped, 'agent', { replace: false }, 'account_automation')).toBe(true);
    // The incumbent flat form still classifies normalized reads on every surface.
    expect(pluginActionRequiresPresentUserIntent({ ...action, confirmationWhen: predicate }, 'agent', { replace: false })).toBe(false);
  });

  it('admits a warning-confirmed read without classifying it as a remote write', () => {
    const action = PluginActionContributionV2Schema.parse({
      id: 'sensitive/read', title: 'Read captured variables', description: 'Read a selected occurrence.',
      execution: { target: 'daemon' }, scopes: ['global'],
      surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [], dangerLevel: 'safe',
      confirmation: { title: 'Reveal captured variables?', body: 'Captured values can contain credentials.' },
    });
    expect(action.dangerLevel).toBe('safe');
    expect(pluginActionRequiresPresentUserIntent(action, 'agent')).toBe(true);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: false }, 'agent')).toBe(false);
    expect(pluginActionRequiresPresentUserIntent({ ...action, approvalRequiredByActionSettings: true }, 'agent')).toBe(true);
    const { confirmation: _confirmation, ...withoutConfirmation } = action;
    expect(PluginActionContributionV2Schema.safeParse({ ...withoutConfirmation, dangerLevel: 'writesRemote' }).success).toBe(false);
    expect(PluginActionContributionV2Schema.safeParse({ ...action, unrecognizedAuthority: true }).success).toBe(false);
  });

  it('accepts only bounded localized title and body presentation', () => {
    expect(PluginActionConfirmationV2Schema.parse({
      title: { key: 'automation.historyGapReset.title', fallback: 'Start a new baseline' },
      body: {
        key: 'automation.historyGapReset.body',
        fallback: 'Events in the history gap are not replayed.',
      },
    })).toMatchObject({
      title: { fallback: 'Start a new baseline' },
      body: { fallback: 'Events in the history gap are not replayed.' },
    });
    expect(PluginActionConfirmationV2Schema.safeParse({
      title: 'x'.repeat(1_025),
    }).success).toBe(false);
    expect(PluginActionConfirmationV2Schema.safeParse({
      title: 'Start a new baseline',
      body: 'x'.repeat(4_097),
    }).success).toBe(false);
  });
});
