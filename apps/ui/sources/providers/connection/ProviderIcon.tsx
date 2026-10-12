import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { HappierBrandMark } from '@happier-dev/plugin-ui/presentation';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ICON_REGISTRY } from '@/components/ui/icons/iconRegistry.generated';

import { useBundledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

function contributedIconName(value: string | null | undefined): IconName | null {
    if (!value) return null;
    return Object.hasOwn(ICON_REGISTRY, value) ? value as IconName : null;
}

/**
 * Provider identity uses the same manifest-declared packaged mark as plugin chrome.
 * Contributions without packaged artwork retain their declared glyph or the neutral cube.
 */
export const ProviderIcon = React.memo(function ProviderIcon(props: Readonly<{
    contributionKey?: string | null;
    icon: string | null | undefined;
    size: number;
    color: string;
}>) {
    const { theme } = useUnistyles();
    const pluginId = parseProviderContributionIdentityV1(props.contributionKey)?.identity.pluginId;
    const brand = useBundledPluginBrandPresentation(pluginId);
    const presentationTheme = React.useMemo(() => {
        const projected = projectPluginUiTheme(theme);
        return { ...projected, colors: { ...projected.colors, text: props.color } };
    }, [theme, props.color]);
    if (brand) return <HappierBrandMark {...brand} size="small" pixelSize={props.size} theme={presentationTheme} externallyLabelled />;
    return (
        <Icon
            name={contributedIconName(props.icon) ?? 'cube'}
            size={props.size}
            color={props.color}
        />
    );
});
