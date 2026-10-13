import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1, type ActionId } from '@happier-dev/protocol';

import * as actionSettingsTargets from './actionSettingsTargets';

const resolveControlState = actionSettingsTargets.resolveActionSettingsTargetControlState;
const applyControlState = actionSettingsTargets.applyActionSettingsTargetControlState;

describe('resolveActionSettingsTargetControlState', () => {
    it.each(['workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove'] as const)(
        'keeps %s Agent confirmation mandatory despite persisted waivers and preserves off/enable continuity',
        (actionId) => {
            const waived = { ...DEFAULT_ACTIONS_SETTINGS_V1, approvalWaivedSurfaces: { [actionId]: ['agent' as const] } };
            expect(actionSettingsTargets.resolveActionSettingsTargetControlState({ settings: waived, actionId, targetId: 'agent' }))
                .toMatchObject({ kind: 'approval', value: 'ask_first', approvalRequiredByPolicy: true, approvalWaivable: false });
            const off = actionSettingsTargets.applyActionSettingsTargetControlState({ settings: waived, actionId, targetId: 'agent', value: 'off' });
            expect(actionSettingsTargets.resolveActionSettingsTargetControlState({ settings: off, actionId, targetId: 'agent' }))
                .toMatchObject({ value: 'off', approvalWaivable: false });
            const enabled = actionSettingsTargets.applyActionSettingsTargetControlState({ settings: off, actionId, targetId: 'agent', value: 'allowed' });
            expect(enabled.approvalWaivedSurfaces?.[actionId]).toBeUndefined();
            expect(actionSettingsTargets.resolveActionSettingsTargetControlState({ settings: enabled, actionId, targetId: 'agent' }))
                .toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true, approvalWaivable: false });
        },
    );

    it('resolves approval-capable targets to the inherited default', () => {

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'mcp',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
        });
    });

    it('resolves approval-required surfaces to ask first', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('resolves opt-in placements to simple off and on states', () => {
        const enabledSettings = actionSettingsTargets.setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            selected: true,
        });

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'off',
        });
        expect(resolveControlState({
            settings: enabledSettings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('requires confirmation for a dangerous Agent Action by default', () => {

        // `prompt_doc.update` is the LIVE-1 fixture: danger + agent with no persisted override.
        const state = resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        });

        // The tab stays on the inherited `default`; what the row must not do is
        // leave that default unstated, because on `agent` it really does confirm.
        expect(state).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'agent',
            approvalRequiredByPolicy: true,
            approvalWaivable: true,
        });
    });

    it('reports assignment confirmation on the app as required by default, and a waiver as allowed', () => {

        // The picker has no confirmation host of its own, so the canonical policy
        // requires confirmation by default and routes it to an approval
        // (teams-lane-04/11-responsible-assignment.md §7.1). A person may waive it.
        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: true,
            approvalWaivable: true,
        });

        const waived = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
            value: 'allowed',
        });

        expect(resolveControlState({
            settings: waived,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toEqual({
            kind: 'approval',
            value: 'allowed',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
        });
    });

    it('does not floor read-only agent actions or non-agent surfaces (CON-5)', () => {

        // Read-only agent verb: not floored.
        const readOnly = resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'browser.automation.snapshot' as ActionId,
            targetId: 'agent',
        });
        expect(readOnly).toMatchObject({ kind: 'approval', value: 'default' });
    });

    it('preserves a disabled floored agent target as stricter than ask_first (LIVE-1)', () => {
        const settings = actionSettingsTargets.setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
            selected: false,
        });

        expect(resolveControlState({
            settings,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        })).toEqual({
            kind: 'approval',
            value: 'off',
            approvalSurface: 'agent',
            approvalRequiredByPolicy: true,
            approvalWaivable: true,
        });
    });

    it('persists an explicit dangerous Action waiver and restores the default', () => {

        const next = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
            value: 'allowed',
        });
        const state = resolveControlState({
            settings: next,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        });
        expect(state).toMatchObject({ value: 'allowed' });
        expect(next.approvalWaivedSurfaces?.['prompt_doc.update']).toEqual(['agent']);
        const restored = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: next,
            actionId: 'prompt_doc.update',
            targetId: 'agent',
            approvalRequired: null,
        });
        expect(resolveControlState({ settings: restored, actionId: 'prompt_doc.update', targetId: 'agent' }))
            .toMatchObject({ value: 'default' });
    });

    it('restores inherited approval policy without disabling the surface', () => {
        const required = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'ask_first',
        });

        const restored = applyControlState({
            settings: required,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'default',
        });

        expect(restored.actions['review.start']?.approvalRequiredSurfaces ?? []).toEqual([]);
        expect(restored.approvalWaivedSurfaces?.['review.start']).toBeUndefined();
        expect(resolveControlState({
            settings: restored,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({ kind: 'approval', value: 'default' });
    });

    it('does not expose approval controls for approval actions', () => {

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'approval.request.create',
            targetId: 'mcp',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('preserves target preferences while resolving a globally disabled action', () => {
        const settings = actionSettingsTargets.setActionEnabled({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            enabled: false,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('applies off by disabling the target and clearing matching approval state', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'off',
        });

        expect(next.actions['review.start']).toMatchObject({
            enabledPlacements: [],
            disabledSurfaces: ['mcp'],
            disabledPlacements: [],
            approvalRequiredSurfaces: [],
        });
    });

    it('applies allowed by enabling the target and clearing matching approval state', () => {
        const settings = actionSettingsTargets.setActionTargetSelected({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            targetId: 'mcp',
            selected: false,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'allowed',
        });

        expect(next.actions['review.start']?.approvalRequiredSurfaces ?? []).toEqual([]);
        expect(next.approvalWaivedSurfaces?.['review.start']).toEqual(['mcp']);
    });

    it('applies simple off without clearing unrelated approval surfaces', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            value: 'off',
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
            toolExposureModes: {},
        });
    });
});
