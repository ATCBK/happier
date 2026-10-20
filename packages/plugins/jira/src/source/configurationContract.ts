import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceConnectedAccountBindingV1Schema, TriageSourceInstanceConfigurationV1Schema, TriageSourceFailureV1Schema,
    TriageSourceScopeSelectionV1Schema, TriageSourceScopeUnitV1Schema, type TriageSourceScopeUnitV1,
    type TriageSourceScopeSelectionV1, type TriageSourceInstanceConfigurationV1 } from '@happier-dev/triage-protocol/v1';

const id = defineProtocolString({ minLength: 1, pattern: '^\\d+$' });
const text = defineProtocolString({ minLength: 1 });
const involvement = defineProtocolUnion([defineProtocolLiteral('mine'), defineProtocolLiteral('assignee'),
    defineProtocolLiteral('author'), defineProtocolLiteral('subscribed'), defineProtocolLiteral('all')]);
const historicalConfiguration = defineProtocolObject({
    v: defineProtocolLiteral(1), projectId: id, involvement,
    issueTypeId: id.optional(),
}, { policy: 'closed' });
export const JiraConfigurationSchema = defineProtocolObject({
    v: defineProtocolLiteral(2), scope: TriageSourceScopeSelectionV1Schema, involvement,
    scopeUnits: defineProtocolArray(TriageSourceScopeUnitV1Schema).optional(),
    // Jira create metadata is project-specific; these are explicit create defaults, not scan scope.
    projectId: id.optional(), issueTypeId: id.optional(),
}, { policy: 'closed' });
export type JiraConfiguration = ReturnType<typeof JiraConfigurationSchema.parse>;

export const JiraProjectCursorSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), boundary: text, query: defineProtocolString(),
    startAt: defineProtocolNumber({ integer: true, minimum: 0 }),
}, { policy: 'closed' });

export function jiraProjectIncluded(configuration: JiraConfiguration, projectId: string): boolean {
    return configuration.scope.kind === 'all' || configuration.scope.unitIds.includes(projectId);
}

/** One source-private reader for historical singleton tokens and current site selections. */
export function parseJiraConfiguration(token: string): JiraConfiguration | null {
    let raw: unknown;
    try { raw = JSON.parse(token); } catch { return null; }
    const current = JiraConfigurationSchema.safeParse(raw);
    if (current.success) {
        const value = current.data;
        if (value.scope.kind === 'selected' && value.scope.unitIds.some((value) => !id.safeParse(value).success)) return null;
        if (value.projectId !== undefined && !jiraProjectIncluded(value, value.projectId)) return null;
        if (value.issueTypeId !== undefined && value.projectId === undefined) return null;
        if (value.scopeUnits?.some((unit) => !id.safeParse(unit.id).success)) return null;
        return { ...value, ...(value.scopeUnits === undefined ? {} : {
            scopeUnits: value.scopeUnits.map(({ collisionScope: ignoredIdentityJoin, ...unit }) => unit),
        }) };
    }
    const previous = historicalConfiguration.safeParse(raw);
    return previous.success ? { ...previous.data, v: 2, scope: { kind: 'selected', unitIds: [previous.data.projectId] } } : null;
}

export function encodeJiraConfiguration(configuration: JiraConfiguration): TriageSourceInstanceConfigurationV1 | null {
    const value = parseJiraConfiguration(JSON.stringify(configuration));
    if (value === null) return null;
    const encoded = TriageSourceInstanceConfigurationV1Schema.safeParse({ v: 1, token: JSON.stringify(value) });
    return encoded.success ? encoded.data : null;
}

export function jiraConfiguredScopeUnits(configuration: JiraConfiguration): TriageSourceScopeUnitV1[] {
    return configuration.scope.kind === 'all' ? [] : configuration.scope.unitIds.map((id) => {
        const unit = configuration.scopeUnits?.find((unit) => unit.id === id);
        // Project metadata never changes Jira's site-wide entry identity or invents an identity join.
        return { id, label: unit?.label ?? id, ...(unit?.secondaryText ? { secondaryText: unit.secondaryText } : {}) };
    });
}

export function selectJiraProjects(token: string, scope: TriageSourceScopeSelectionV1,
    units: readonly TriageSourceScopeUnitV1[]): TriageSourceInstanceConfigurationV1 | null {
    const current = parseJiraConfiguration(token);
    if (current === null) return null;
    const { projectId, issueTypeId, ...base } = current;
    const keepCreate = projectId !== undefined && (scope.kind === 'all' || scope.unitIds.includes(projectId));
    const retained = new Map([...(current.scopeUnits ?? []), ...units].map((unit) => [unit.id, unit]));
    return encodeJiraConfiguration({ ...base, scope,
        scopeUnits: scope.kind === 'all' ? [] : scope.unitIds.map((id) => {
            const unit = retained.get(id);
            return { id, label: unit?.label ?? id, ...(unit?.secondaryText ? { secondaryText: unit.secondaryText } : {}) };
        }), ...(keepCreate ? { projectId, ...(issueTypeId ? { issueTypeId } : {}) } : {}) });
}

// The shared editor owns draft lifecycle; this Action reads only provider choices.
export const JiraIssueTypesInputSchema = defineProtocolObject({ binding: TriageSourceConnectedAccountBindingV1Schema,
    localInstanceKey: text, configuration: TriageSourceInstanceConfigurationV1Schema,
}, { policy: 'closed' });
export const JiraIssueTypesResultSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('complete'),
        issueTypes: defineProtocolArray(defineProtocolObject({ id, name: text }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type JiraIssueTypesResult = ReturnType<typeof JiraIssueTypesResultSchema.parse>;
