import type { PluginContributionKind } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { t } from '@/text';

/** A shelf of the Installed collection: the kind of thing its plugins add ("Agents", "Code hosting"). */
export type PluginKindShelf = Readonly<{
  key: PluginKindShelfKey;
  title: string;
}>;

/** Shelves in the order a person scans them, most identifying kind first; a plugin sits on the first it has. */
export const PLUGIN_KIND_SHELF_ORDER = [
    'agent',
    'machines',
    'providers',
    'scmHostingProviders',
    'scmBackends',
    'voice',
    'roles',
    'workflows',
    'inputTypes',
    'mcp',
    'pluginBrowser',
    'composer',
    'pluginUi',
    'connectedAccounts',
] as const;

export type PluginKindShelfKey = (typeof PLUGIN_KIND_SHELF_ORDER)[number];

/**
 * The kind of thing a plugin adds: its most identifying projected contribution kind.
 * Kinds that describe plumbing (managed dependencies, Account collections) have no shelf. `null` when
 * nothing recognisable is projected, so a plugin is never given an invented kind.
 */
export function resolvePluginKindShelf(kinds: readonly PluginContributionKind[] | null | undefined): PluginKindShelf | null {
    // The most identifying kind wins, whatever order the machine projected them in: nearly every plugin
    // signs in to something or adds a panel, and neither says what the plugin is for.
    const keys = new Set((kinds ?? []).map(shelfKeyFor));
    const key = PLUGIN_KIND_SHELF_ORDER.find((candidate) => keys.has(candidate));
    return key ? { key, title: pluginKindShelfTitle(key) } : null;
}

export function pluginKindShelfTitle(key: PluginKindShelfKey): string {
  switch (key) {
    case 'agent':
      return t('settingsPlugins.surfaces.kinds.agent');
    case 'machines':
      return t('settings.machines');
    case 'roles':
      return t('roles.rail.label');
    case 'workflows':
      return t('workflows.title');
    case 'providers':
      return t('settingsPlugins.surfaces.kinds.providers');
    case 'scmHostingProviders':
      return t('settingsPlugins.surfaces.kinds.scmHostingProviders');
    case 'scmBackends':
      return t('settingsPlugins.surfaces.kinds.scmBackends');
    case 'voice':
      return t('settingsPlugins.surfaces.kinds.voice');
    case 'connectedAccounts':
      return t('settingsPlugins.surfaces.kinds.connectedAccounts');
    case 'inputTypes':
      return t('settingsPlugins.surfaces.kinds.inputTypes');
    case 'mcp':
      return t('settingsPlugins.surfaces.kinds.mcp');
    case 'pluginUi':
      return t('settingsPlugins.surfaces.kinds.pluginUi');
    case 'pluginBrowser':
      return t('settingsPlugins.surfaces.kinds.pluginBrowser');
    case 'composer':
      return t('settingsPlugins.surfaces.kinds.composer');
  }
  key satisfies never;
  return key;
}

function shelfKeyFor(kind: PluginContributionKind): PluginKindShelfKey | null {
  switch (kind) {
    case 'agent':
    case 'roles':
    case 'workflows':
    case 'providers':
    case 'scmHostingProviders':
    case 'scmBackends':
    case 'connectedAccounts':
    case 'inputTypes':
    case 'mcp':
    case 'pluginUi':
    case 'pluginBrowser':
      return kind;
    case 'machineProvisioners':
      return 'machines';
    case 'voiceProviders':
    case 'voiceModelPacks':
      return 'voice';
    case 'composerAttachments':
    case 'composerControls':
    case 'composerRegions':
      return 'composer';
    case 'managedDependencies':
    case 'accountCollections':
    case 'registrySources':
    case 'atmospherePictures':
    case 'dragSources':
    case 'workItems':
    case 'dropTargets':
    case 'skills':
      return null;
  }
  kind satisfies never;
  return null;
}
