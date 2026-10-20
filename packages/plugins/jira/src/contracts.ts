export const JIRA_PLUGIN_ID = 'happier.jira';
export const JIRA_ACCOUNT_PURPOSE = 'jira-account';
export const JIRA_SOURCE_ID = 'jira-issues';
export const JIRA_ACTIONS = {
    listInstances: 'triage/list-instances', listScopeUnits: 'triage/list-projects', scan: 'triage/scan', get: 'triage/get',
    detail: 'triage/read-detail', create: 'issues/create', edit: 'issues/edit',
    transition: 'issues/transition', comment: 'issues/comment', issueTypes: 'issues/list-types',
} as const;
