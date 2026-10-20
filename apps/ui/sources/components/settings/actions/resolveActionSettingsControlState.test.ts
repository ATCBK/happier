import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1, type ActionId } from '@happier-dev/protocol';

import * as actionSettingsTargets from './actionSettingsTargets';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getActionTargetApprovalOverride } from './actionSettingsTargetApproval';

const resolveControlState = actionSettingsTargets.resolveActionSettingsTargetControlState;
const applyControlState = actionSettingsTargets.applyActionSettingsTargetControlState;

describe('resolveActionSettingsTargetControlState', () => {
    it.each(['cli', 'agent', 'mcp'] as const)('restores default approval when Ask first is chosen again on %s', (targetId) => {
        const actionId = 'mcp.servers.signIn.start';
        const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value: 'allowed' });
        expect(resolveControlState({ settings: allowed, actionId, targetId }))
            .toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });

        const restored = applyControlState({ settings: allowed, actionId, targetId, value: 'ask_first' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: true });
    });

    it('restores a direct UI default while preserving other audience and Action preferences', () => {
        const actionId = 'mcp.servers.tools.set';
        const neighbour = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'review.start', targetId: 'cli', value: 'off' });
        const cliAllowed = applyControlState({ settings: neighbour, actionId, targetId: 'cli', value: 'allowed' });
        const asking = applyControlState({ settings: cliAllowed, actionId, targetId: 'contextual_ui', value: 'ask_first' });
        expect(resolveControlState({ settings: asking, actionId, targetId: 'contextual_ui' }))
            .toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true });

        const restored = applyControlState({ settings: asking, actionId, targetId: 'contextual_ui', value: 'allowed' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'contextual_ui' })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId: 'contextual_ui' }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: false });
        expect(restored.approvalWaivedSurfaces?.[actionId]).toEqual(['cli']);
        expect(restored.actions['review.start']).toEqual(neighbour.actions['review.start']);
    });

    it.each(['safe', 'writesLocal'] as const)('restores a contributed Action default from its %s declaration', (dangerLevel) => {
        const actionId = 'example.capabilities/actions/change';
        const target = actionSettingsTargets.listActionSettingsTargetDefinitions({
            surfaces: { cli: true }, placements: [], contributedAction: { dangerLevel },
        }).find(target => target.id === 'cli')!;
        const approvalRequired = dangerLevel !== 'safe';
        const changed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'cli', target,
            value: approvalRequired ? 'allowed' : 'ask_first' });
        const restored = applyControlState({ settings: changed, actionId, targetId: 'cli', target,
            value: approvalRequired ? 'ask_first' : 'allowed' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'cli', target })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId: 'cli', target }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: approvalRequired });
    });

    it.each(['workflow.trigger.add', 'workflow.trigger.update', 'workflow.trigger.remove'] as const)(
        'keeps %s Agent confirmation mandatory despite persisted waivers and preserves off/enable continuity',
        (actionId) => {
            const spec = getActionSpec(actionId);
            const descriptor = Object.getOwnPropertyDescriptor(spec, 'approvalPolicy')!;
            // Production triggers permit waivers; the mandatory contract needs
            // an explicit host declaration rather than a special Action-id rule.
            Object.defineProperty(spec, 'approvalPolicy', { ...descriptor, value: { ...spec.approvalPolicy, nonWaivable: true } });
            try {
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
            } finally { Object.defineProperty(spec, 'approvalPolicy', descriptor); }
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
            approvalAskedBySourceControl: false,
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
            approvalAskedBySourceControl: false,
        });
    });

    it('inherits the declared direct UI assignment policy without retaining a redundant waiver', () => {

        // Assignment now declares direct UI admission at the canonical Action spec.
        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
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
            value: 'default',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
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
            approvalAskedBySourceControl: false,
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
        expect(next.approvalWaivedSurfaces?.['review.start']).toBeUndefined();
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
    describe('Source Control remote confirmation preference', () => {
        it.each(['always', 'never'] as const)('restores the inherited %s preference when the matching answer is chosen', (scmRemoteConfirmPolicy) => {
            const actionId = 'scm.remote.push';
            const value = scmRemoteConfirmPolicy === 'always' ? 'ask_first' : 'allowed';
            const opposite = value === 'ask_first' ? 'allowed' : 'ask_first';
            const changed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy, value: opposite });
            const restored = applyControlState({ settings: changed, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy, value });
            expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'contextual_ui' })).toBeNull();
            expect(resolveControlState({ settings: restored, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy }))
                .toMatchObject({ value: 'default', approvalRequiredByPolicy: scmRemoteConfirmPolicy === 'always' });
        });

        const remote = (actionId: 'scm.remote.pull' | 'scm.remote.push', scmRemoteConfirmPolicy: unknown) => resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy,
        });

        it('reports the inherited default of pull and push as asking when the preference asks, and says why', () => {
            expect(remote('scm.remote.push', 'push_only')).toMatchObject({
                kind: 'approval', value: 'default', approvalRequiredByPolicy: true, approvalWaivable: true, approvalAskedBySourceControl: true,
            });
            expect(remote('scm.remote.pull', 'always')).toMatchObject({ approvalRequiredByPolicy: true, approvalAskedBySourceControl: true });
            // The preference is per operation: pushing is not affected by a pull-only preference.
            expect(remote('scm.remote.push', 'pull_only')).toMatchObject({ approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
            expect(remote('scm.remote.push', 'never')).toMatchObject({ approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
        });

        it('leaves an explicit choice in charge: Allowed does not ask, and Ask first is the Action policy rather than the preference', () => {
            const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always', value: 'allowed' });
            expect(resolveControlState({ settings: allowed, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always' }))
                .toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
            const askFirst = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'never', value: 'ask_first' });
            expect(resolveControlState({ settings: askFirst, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always' }))
                .toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true, approvalAskedBySourceControl: false });
        });
    });
});
