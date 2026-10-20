import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
    TriageListInstancesInputV1Schema, TriageListInstancesResultV1Schema,
    TriageGetInputV1Schema, TriageScanInputV1Schema, TriageScanContinuationV1Schema,
    TriageSourceInstanceDraftV1Schema, isTriageSourceConnectedAccountInstanceV1,
    type TriageListInstancesResultV1, type TriageScanResultV1, type TriageGetResultV1,
    type TriageConfiguredSourceInstanceV1, type TriageSourceEntryLocalRefV1,
} from '@happier-dev/triage-protocol/v1';
import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';
import { JIRA_ACCOUNT_PURPOSE } from '../contracts.js';
import { createJiraClient, invalidJira, jiraCloudOrigin, jiraFailure, numericId, object, string, type JiraClient } from '../api.js';
import { readJiraConfiguration, readJiraIssue, projectJiraIssue, jiraTaskFields, type JiraConfiguration, type JiraIssue } from './model.js';
import { readJiraTaskCapabilities } from './metadata.js';
import { encodeJiraConfiguration, jiraProjectIncluded } from './configurationContract.js';

function sameAccount(a: ConnectedAccountRef, b: ConnectedAccountRef): boolean {
    return a.accountId === b.accountId && a.service.pluginId === b.service.pluginId && a.service.localId === b.service.localId;
}
async function listedAccounts(context: PluginInvocationContext) {
    const outcome = await readTriageSourceAccountListingV1({ connectedAccounts: context.services.connectedAccounts,
        purpose: JIRA_ACCOUNT_PURPOSE, signal: context.signal });
    if (outcome.kind === 'failed') throw invalidJira('jira/accountListingUnavailable');
    return outcome.kind === 'unbound' ? { status: 'complete' as const, accounts: [] } : outcome.listing;
}

export async function listJiraInstances(input: unknown, context: PluginInvocationContext): Promise<TriageListInstancesResultV1> {
    TriageListInstancesInputV1Schema.parse(input);
    try {
        const listing = await listedAccounts(context);
        const candidates: Extract<TriageListInstancesResultV1, { kind: 'complete' }>['candidates'][number][] = [];
        const failures: Extract<TriageListInstancesResultV1, { kind: 'complete' }>['failures'][number][] = [];
        let incomplete = listing.status !== 'complete';
        for (const entry of listing.accounts) {
            const binding = { purpose: JIRA_ACCOUNT_PURPOSE, account: entry.account };
            try {
                const origin = entry.connectedAccountOrigins.length === 1 ? jiraCloudOrigin(entry.connectedAccountOrigins[0]) : null;
                if (origin === null) throw invalidJira('jira/siteUndeclared');
                const configuration = encodeJiraConfiguration({ v: 2, scope: { kind: 'all' }, involvement: 'mine' });
                if (configuration === null) throw invalidJira('jira/configurationInvalid');
                const draft = TriageSourceInstanceDraftV1Schema.safeParse({
                    v: 1, binding, localInstanceKey: origin, keyStability: 'locatorDerived',
                    configuration,
                    locator: { v: 1, displayLabel: entry.displayName ?? new URL(origin).hostname,
                        displayPath: new URL(origin).hostname, webUrl: origin },
                });
                if (draft.success) candidates.push(draft.data); else incomplete = true;
            } catch (error) { failures.push({ binding, failure: jiraFailure(error) }); }
        }
        return TriageListInstancesResultV1Schema.parse({ kind: incomplete ? 'incomplete' : 'complete', candidates, failures });
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}

export async function openJiraInstance(instance: Pick<TriageConfiguredSourceInstanceV1, 'binding' | 'configuration' | 'localInstanceKey'>, context: PluginInvocationContext,
    ref?: TriageSourceEntryLocalRefV1): Promise<{ client: JiraClient; configuration: JiraConfiguration }> {
    if (!isTriageSourceConnectedAccountInstanceV1(instance) || instance.binding.purpose !== JIRA_ACCOUNT_PURPOSE) throw invalidJira('jira/bindingInvalid');
    const configuration = readJiraConfiguration(instance.configuration.token);
    const separator = instance.localInstanceKey.lastIndexOf('#');
    const origin = jiraCloudOrigin(separator < 0 ? instance.localInstanceKey : instance.localInstanceKey.slice(0, separator));
    // Retained project instances keep their original key when explicitly reconfigured.
    if (origin === null || (separator >= 0 && !numericId(instance.localInstanceKey.slice(separator + 1)))) throw invalidJira('jira/instanceMismatch');
    if (ref !== undefined && (ref.kindId !== 'issue' || ref.collisionScope !== `jira:${origin}` || !numericId(ref.entryId))) throw invalidJira('jira/entryMismatch');
    const listing = await listedAccounts(context);
    const accountRef = instance.binding.account;
    const account = listing.accounts.find((row) => sameAccount(row.account, accountRef));
    if (account === undefined || account.connectedAccountOrigins.length !== 1 || jiraCloudOrigin(account.connectedAccountOrigins[0]) !== origin) throw invalidJira('jira/accountSiteMismatch');
    return { client: createJiraClient(context, accountRef, origin), configuration };
}

export async function jiraViewer(client: JiraClient): Promise<string> {
    const id = string(object(await client.request('/rest/api/3/myself')).accountId);
    if (id === undefined) throw invalidJira('jira/viewerUnavailable');
    return id;
}
const SCAN_FIELDS = ['summary', 'project', 'status', 'issuetype', 'priority', 'creator', 'assignee', 'watches', 'created', 'updated', 'duedate', 'resolutiondate', 'parent', 'subtasks', 'issuelinks'];

function jql(configuration: JiraConfiguration): string {
    const clauses = { assignee: 'assignee = currentUser()', author: 'creator = currentUser()', subscribed: 'watcher = currentUser()',
        mine: '(assignee = currentUser() OR creator = currentUser() OR watcher = currentUser())', all: '' };
    const project = configuration.scope.kind === 'selected' ? `project IN (${configuration.scope.unitIds.join(',')})` : '';
    return `${[project, clauses[configuration.involvement]].filter(Boolean).join(' AND ')}${project || clauses[configuration.involvement] ? ' ' : ''}ORDER BY updated DESC, id DESC`;
}

export async function scanJiraSource(raw: unknown, context: PluginInvocationContext): Promise<TriageScanResultV1> {
    const input = TriageScanInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context);
        let limit: number;
        let nextPageToken: string | undefined;
        if (input.page.kind === 'initial') limit = input.page.limit;
        else {
            const cursor = object(JSON.parse(input.page.continuation.token));
            if (cursor.v !== 1 || cursor.instance !== input.instance.localInstanceKey || cursor.configuration !== input.instance.configuration.token
                || !Number.isSafeInteger(cursor.limit) || Number(cursor.limit) < 1 || !string(cursor.nextPageToken)) throw invalidJira('jira/continuationInvalid');
            limit = Number(cursor.limit); nextPageToken = String(cursor.nextPageToken);
        }
        const viewer = await jiraViewer(client);
        const page = object(await client.request('/rest/api/3/search/jql', 'POST', { jql: jql(configuration), fields: SCAN_FIELDS,
            maxResults: limit, ...(nextPageToken === undefined ? {} : { nextPageToken }) }));
        if (!Array.isArray(page.issues) || typeof page.isLast !== 'boolean' || page.issues.length > limit) throw invalidJira();
        const observations: Extract<TriageScanResultV1, { kind: 'complete' }>['observations'][number][] = [];
        let omitted = 0;
        for (const rawIssue of page.issues) {
            const issue = readJiraIssue(rawIssue);
            if (issue === null || !jiraProjectIncluded(configuration, String(object(issue.fields.project).id))) { omitted++; continue; }
            try { observations.push(projectJiraIssue(issue, client.origin, viewer)); } catch { omitted++; }
        }
        const evidence = omitted > 0 ? { kind: 'partial' as const, reason: 'jira/providerRowsInvalid', omittedItemCount: omitted } : { kind: 'walkFinished' as const };
        if (page.isLast) return { kind: 'complete', observations, evidence };
        const next = string(page.nextPageToken);
        if (next === undefined || next === nextPageToken) throw invalidJira('jira/searchPageInvalid');
        const continuation = TriageScanContinuationV1Schema.parse({ v: 1, token: JSON.stringify({ v: 1,
            instance: input.instance.localInstanceKey, configuration: input.instance.configuration.token, limit, nextPageToken: next }) });
        return { kind: 'page', observations, evidence: omitted > 0 ? evidence : { kind: 'partial', reason: 'jira/providerContinuation' }, continuation };
    } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}

export async function readExactJiraIssue(client: JiraClient, configuration: JiraConfiguration, id: string): Promise<JiraIssue> {
    const issue = readJiraIssue(await client.request(`/rest/api/3/issue/${encodeURIComponent(id)}?fields=*all&expand=names,schema`));
    if (issue === null || issue.id !== id || !jiraProjectIncluded(configuration, String(object(issue.fields.project).id))) throw invalidJira('jira/entryMoved');
    return issue;
}

export async function getJiraEntry(raw: unknown, context: PluginInvocationContext): Promise<TriageGetResultV1> {
    const input = TriageGetInputV1Schema.parse(raw);
    try {
        const { client, configuration } = await openJiraInstance(input.instance, context, input.localRef);
        const issue = await readExactJiraIssue(client, configuration, input.localRef.entryId);
        const observation = projectJiraIssue(issue, client.origin, await jiraViewer(client));
        return { ...observation, taskFields: jiraTaskFields(issue, client.origin),
            snapshot: { ...observation.snapshot, taskCapabilities: await readJiraTaskCapabilities(client, issue) } };
    } catch (error) { return { kind: 'unresolved', localRef: input.localRef, failure: jiraFailure(error) }; }
}
