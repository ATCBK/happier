import type { ParsedPluginManifestV2 } from '@happier-dev/protocol';
import type { ResolvedNotificationChannelContribution } from '@/plugins/projection/registry/types';

import { admitLocalSettingsDeclarations } from './localSettingsContributions';
import { resolveNotificationChannelSettingsContributions } from './notificationChannelSettings';

/** Author and install ingress refuse invalid groups before publishing a new manifest. */
export function assertPluginManifestSettingsValid(manifest: ParsedPluginManifestV2): void {
    const settings = manifest.contributes.settings.map(definition => ({ pluginId: manifest.id, definition }));
    const channels = resolveNotificationChannelSettingsContributions(manifest.contributes.notificationChannels.map(definition => ({
        pluginId: manifest.id, definition, provenance: 'external', source: { kind: 'path' },
    } satisfies ResolvedNotificationChannelContribution)));
    const { errors } = admitLocalSettingsDeclarations({ settings: [...settings, ...channels] });
    if (errors[0]) throw errors[0];
}
