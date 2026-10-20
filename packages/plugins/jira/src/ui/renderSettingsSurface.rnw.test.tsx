// @vitest-environment jsdom
import { act } from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { TriageSourceAdministrationActionInputV1Schema, TriageSourceInstanceDraftV1Schema,
    TriageListScopeUnitsInputV1Schema, TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, expect, it } from 'vitest';
import { JIRA_ACTIONS, JIRA_PLUGIN_ID } from '../contracts.js';
import { jiraConfiguredScopeUnits, parseJiraConfiguration } from '../source/configurationContract.js';
import { renderSurface } from './renderSettingsSurface.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let mounted: PluginUiTestkit | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

// Only the host Action transport is substituted. The real SDK mount, shared editor,
// Jira native fields and canonical configuration codec all participate in the save.
it('saves a multi-project selection without losing historical native creation defaults', async () => {
    const sourceInstanceId = '11111111-1111-4111-8111-111111111111';
    const draft = TriageSourceInstanceDraftV1Schema.parse({
        v: 1, binding: { purpose: 'jira-account', account: {
            service: { pluginId: JIRA_PLUGIN_ID, localId: 'jira-account' }, accountId: 'account-1',
        } }, localInstanceKey: 'https://work.atlassian.net#10000', keyStability: 'locatorDerived',
        locator: { v: 1, displayLabel: 'Work Jira', displayPath: 'https://work.atlassian.net' },
        configuration: { v: 1, token: JSON.stringify({ v: 1, projectId: '10000', issueTypeId: '10002', involvement: 'mine' }) },
    });
    const units = [{ id: '10000', label: 'Platform', secondaryText: 'ABC' }, { id: '10001', label: 'Mobile', secondaryText: 'MOB' }];
    let saved = draft;
    let administrations = 0;
    await act(async () => {
        mounted = await createPluginUiTestkit({
            identity: { instanceId: 'jira-settings', mountNonce: 'jira-settings-mount' },
            authorPlugin: { id: JIRA_PLUGIN_ID, version: '0.0.0' }, surface: renderSurface,
            surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter({ overlays: true }),
            handlers: { executeAction: async ({ action, input }): Promise<JsonValue> => {
                if (action.localId === JIRA_ACTIONS.listInstances) return { kind: 'complete', candidates: [draft], failures: [] };
                if (action.localId === JIRA_ACTIONS.listScopeUnits) {
                    const request = TriageListScopeUnitsInputV1Schema.parse(input);
                    const configuration = parseJiraConfiguration(request.draft.configuration.token)!;
                    return { kind: 'page', status: 'complete', selection: configuration.scope,
                        units: request.mode === 'configured' ? jiraConfiguredScopeUnits(configuration) : units };
                }
                if (action.localId === JIRA_ACTIONS.issueTypes) return { kind: 'complete', issueTypes: [{ id: '10002', name: 'Task' }] };
                if (action.localId === TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1.localId) return {
                    kind: 'read', status: 'complete', instances: [{ v: 1, lifecycle: 'active', configured: {
                        v: 1, binding: saved.binding, localInstanceKey: saved.localInstanceKey,
                        configuration: saved.configuration, locator: saved.locator!,
                        instance: { source: { pluginId: JIRA_PLUGIN_ID, localId: 'jira-issues' }, sourceInstanceId },
                    } }],
                };
                const administration = TriageSourceAdministrationActionInputV1Schema.parse(input);
                if (administration.kind !== 'reconfigure') throw new Error('Expected exact reconfiguration');
                saved = administration.draft; administrations += 1;
                return { kind: 'reconfigured', sourceInstanceId };
            } },
        });
    });
    const page = mounted!;
    const press = async (name: string, role: 'button' | 'radio' | 'checkbox' = 'button') => {
        await act(async () => {
            const target = await page.queryByRole(role, { name });
            expect(target, `${role}: ${name}`).toBeDefined();
            await page.press(target!);
        });
    };
    await press('Update Work Jira from the provider');
    await expect(page.getByText('Issue type for new issues')).resolves.toBeDefined();
    await press('Selected…', 'radio');
    await press('Mobile: MOB', 'checkbox');
    await press('Save selection');
    expect(administrations).toBe(1);
    expect(saved.binding).toEqual(draft.binding);
    expect(saved.localInstanceKey).toBe(draft.localInstanceKey);
    expect(parseJiraConfiguration(saved.configuration.token)).toEqual({
        v: 2, scope: { kind: 'selected', unitIds: ['10000', '10001'] }, scopeUnits: units,
        involvement: 'mine', projectId: '10000', issueTypeId: '10002',
    });
});
