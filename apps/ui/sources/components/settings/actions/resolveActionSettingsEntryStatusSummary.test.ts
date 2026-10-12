import { describe, expect, it } from 'vitest';
import {
    listActionSettingsEntryStatusParts,
    resolveActionSettingsEntryStatusSummary,
    type ActionSettingsEntryStatusTarget,
} from './resolveActionSettingsEntryStatusSummary';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { getActionSettingsTargetDefinition } from './actionSettingsTargets';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

function target(
    id: ActionSettingsEntryStatusTarget['id'],
    state: ActionSettingsEntryStatusTarget['state'] = 'on',
    actionId: Parameters<typeof getActionSettingsTargetDefinition>[0] = 'review.start',
): ActionSettingsEntryStatusTarget {
    return {
        id,
        state,
        definition: getActionSettingsTargetDefinition(actionId, id),
    };
}

describe('resolveActionSettingsEntryStatusSummary', () => {
    it('describes effective approval by audience and declared danger, including an explicit integration waiver', () => {
        const actionId = 'acme.forge/actions/merge' as const;
        const definitions = listActionSettingsTargetDefinitions({
            surfaces: { ui: true, agent: true, mcp: true, api: true, plugin: true },
            placements: [],
            contributedAction: { dangerLevel: 'externalSideEffect' },
        });
        const settings = normalizeActionsSettings({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['plugin'] } });
        const summary = resolveActionSettingsEntryStatusSummary({ settings, actionId, targets: definitions.map((definition) => ({ id: definition.id, definition, state: 'on' })) });
        expect(summary).toMatchObject({
            audiences: [
                { audience: 'human', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                { audience: 'agent', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                { audience: 'integration', allowedCount: 1, askFirstCount: 2, offCount: 0 },
            ],
            danger: 'external',
        });
        expect(listActionSettingsEntryStatusParts(summary).map((part) => part.labelKey)).toEqual([
            'settingsActions.status.humanAskFirst', 'settingsActions.status.agentAskFirst',
            'settingsActions.status.integrationAllowed', 'settingsActions.status.integrationAskFirst',
            'settingsActions.status.external',
        ]);
    });
    it('counts allowed, ask-first, off, and unavailable target states from one action entry', () => {
        const settings = normalizeActionsSettings({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledPlacements: ['command_palette'],
                    disabledSurfaces: [],
                    approvalRequiredSurfaces: ['cli'],
                },
            },
        });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'review.start',
            targets: [
                target('cli'),
                target('command_palette'),
                target('mcp', 'unavailable'),
            ],
        })).toMatchObject({
            allowedCount: 0,
            askFirstCount: 1,
            offCount: 1,
            unavailableCount: 1,
        });
    });

    it('counts an inherited default approval policy as enabled', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'review.start',
            targets: [target('cli')],
        })).toMatchObject({
            allowedCount: 1,
            askFirstCount: 0,
            offCount: 0,
            unavailableCount: 0,
        });
    });

    /**
     * `session.responsibility.set` is a dangerous Action exposed on the in-app,
     * Agent, MCP and CLI surfaces. Its in-app picker has no confirmation host of
     * its own, so the policy's default confirmation applies there too
     * (teams-lane-04/11-responsible-assignment.md §7.1); the summary reads that
     * answer rather than assuming "default" means allowed.
     */
    it('reports every exposed surface of assignment as ask-first by default', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'session.responsibility.set',
            targets: [
                target('contextual_ui', 'on', 'session.responsibility.set'),
                target('agent', 'on', 'session.responsibility.set'),
                target('mcp', 'on', 'session.responsibility.set'),
                target('cli', 'on', 'session.responsibility.set'),
            ],
        })).toMatchObject({
            allowedCount: 0,
            askFirstCount: 4,
            offCount: 0,
            unavailableCount: 0,
        });
    });

    it('omits unavailable targets from the user-facing compact status by default', () => {
        expect(listActionSettingsEntryStatusParts({
            allowedCount: 1,
            askFirstCount: 0,
            offCount: 1,
            unavailableCount: 6,
            audiences: [{ audience: 'integration', allowedCount: 1, askFirstCount: 0, offCount: 1 }],
            danger: null,
        })).toEqual([
            { labelKey: 'settingsActions.status.integrationAllowed', partial: true },
            { labelKey: 'settingsActions.status.integrationOff', partial: true },
        ]);
    });
});
