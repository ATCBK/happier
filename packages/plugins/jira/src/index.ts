export { JIRA_PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest } from './manifest.js';
export { JIRA_ACTIONS, JIRA_ACCOUNT_PURPOSE, JIRA_PLUGIN_ID, JIRA_SOURCE_ID } from './contracts.js';
import { JIRA_PLUGIN } from './manifest.js';
export const activate = JIRA_PLUGIN.activate;
