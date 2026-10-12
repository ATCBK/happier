import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1, type ActionId } from '@happier-dev/protocol';

import {
    getActionTargetApprovalRequired,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
} from './actionSettingsTargetApproval';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

describe('actionSettingsTargetApproval', () => {
    it.each([
        ['review.start', 'mcp', 'mcp'],
        ['review.start', 'cli', 'cli'],
        ['review.start', 'agent', 'agent'],
        ['review.start', 'voice', 'voice'],
        ['review.start', 'slash_command', 'ui'],
        ['approval.request.decide', 'contextual_ui', 'ui'],
    ] as const)('maps %s target %s to approval surface %s', (actionId, targetId, expectedSurface) => {
        expect(resolveActionSettingsApprovalSurface(actionId, targetId)).toBe(expectedSurface);
    });

    it.each([
        ['review.start', 'command_palette'],
        ['review.start', 'session_action_menu'],
        ['review.start', 'voice_panel'],
    ] as const)('does not create approval state for ordinary placement %s:%s', (actionId, targetId) => {
        expect(resolveActionSettingsApprovalSurface(actionId, targetId)).toBeNull();
    });

    it('identifies approval actions so their targets can stay simple switches', () => {
        expect(isActionSettingsApprovalAction('approval.request.create' as ActionId)).toBe(true);
        expect(isActionSettingsApprovalAction('approval.request.decide' as ActionId)).toBe(true);
        expect(isActionSettingsApprovalAction('review.start' as ActionId)).toBe(false);
    });
});

/**
 * The settings screen must report the confirmation the runtime actually applies.
 * Every `ui` target here is an in-app surface the app's own Action executor admits
 * with `authority: 'present_user'` (`sync/api/session/sessionAccessApi.ts`). The
 * canonical policy suppresses its dangerous-Action floor for that pair only where
 * the app hosts its own confirmation; assignment has none, so its confirmation is
 * the policy default (teams-lane-04/11-responsible-assignment.md §7.1).
 */
describe('getActionTargetApprovalRequired', () => {
    it('reports execution approval for a visible contributed placement without turning its visibility into an approval control', () => {
        const actionId = 'acme.forge/actions/delete' as const;
        const target = listActionSettingsTargetDefinitions({
            surfaces: { ui: true }, placements: ['command_palette'],
            contributedAction: { dangerLevel: 'destructive' },
        }).find((entry) => entry.id === 'command_palette')!;
        expect(resolveActionSettingsApprovalSurface(actionId, target.id, target)).toBeNull();
        expect(getActionTargetApprovalRequired({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: target.id, target })).toBe(true);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
            actionId, targetId: target.id, target,
        })).toBe(false);
    });
    it('reports assignment confirmation as required by default on the app, and a ui waiver as not', () => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(true);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: {},
                approvalWaivedSurfaces: { 'session.responsibility.set': ['ui'] },
            }),
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(false);
    });

    it('reports an explicit require', () => {
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: { 'session.responsibility.set': { approvalRequiredSurfaces: ['ui'] } },
            }),
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(true);
    });

    it.each(['agent', 'mcp', 'cli'] as const)('keeps the dangerous-Action floor on %s, which has no present user', (targetId) => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId,
        })).toBe(true);
    });

    it.each([
        'session.access.grant.set',
        'session.access.grant.remove',
        'session.access.context.set',
    ] as const)('reports %s the same way for the mounted Session access editor, with or without an explicit ui waiver', (actionId) => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId,
            targetId: 'contextual_ui',
        })).toBe(false);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: {},
                approvalWaivedSurfaces: { [actionId]: ['ui'] },
            }),
            actionId,
            targetId: 'contextual_ui',
        })).toBe(false);
    });
});
