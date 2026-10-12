import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * An installed plugin's mark beside its name, found by plugin id (the Add surface's sections, the
 * Settings rail's plugin rows): the package's own brand through the one brand presentation owner,
 * or a glyph while the brand is absent or still arriving — the plugin's own icon when it declares
 * one, else the neutral plugin glyph. The adjacent title names the plugin.
 */
export function InstalledPluginMarkById(props: Readonly<{ pluginId: string; size: number; fallbackIcon?: IconName; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
    const app = useAppShellPluginUiProjection();
    const installed = app.pluginUiProjection?.installedPackagesById[props.pluginId] ?? null;
    const installedPackage = app.phase === 'current' && installed?.brand ? installed : null;
    const scope = React.useMemo(() => new AbortController(), [installedPackage, app.machineId, app.serverId]);
    React.useEffect(() => () => scope.abort(), [scope]);
    const brand = useInstalledPluginBrandPresentation({
        installedPackage,
        machineId: app.machineId ?? null,
        serverId: app.serverId ?? null,
        signal: scope.signal,
        accountLifetime: installedPackage ? captureActiveServerAccountScopeLifetime() : null,
        isCurrent: () => installedPackage !== null && !scope.signal.aborted,
    });
    return brand
        ? <InstalledPluginBrandMark brand={brand} externallyLabelled size="small" pixelSize={props.size} {...(props.testID ? { testID: props.testID } : {})} />
        : <Icon name={props.fallbackIcon ?? 'puzzle-piece'} size={props.size} color={theme.colors.text.secondary} {...(props.testID ? { testID: props.testID } : {})} />;
}
