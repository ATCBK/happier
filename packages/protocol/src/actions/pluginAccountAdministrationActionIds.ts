export const PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS = [
  'plugins.account.release.select', 'plugins.account.hosting.set',
  'plugins.account.hosting.remove', 'plugins.account.cache.clear',
] as const;
export type PluginAccountAdministrationActionId = typeof PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS[number];
