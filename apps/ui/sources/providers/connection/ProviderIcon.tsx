import * as React from 'react';
import { SvgXml } from 'react-native-svg';

import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { ICON_REGISTRY } from '@/components/ui/icons/iconRegistry.generated';

import { resolveProviderBrandIconXml } from './providerBrandMarks';

function contributedIconName(value: string | null | undefined): IconName | null {
    if (!value) return null;
    return Object.hasOwn(ICON_REGISTRY, value) ? value as IconName : null;
}

/**
 * The one provider identity mark: a bundled provider's own logo when its contribution's `icon`
 * token names one, otherwise a contributed glyph, otherwise the neutral cube.
 */
export const ProviderIcon = React.memo(function ProviderIcon(props: Readonly<{
    icon: string | null | undefined;
    size: number;
    color: string;
}>) {
    const brandXml = resolveProviderBrandIconXml(props.icon, props.color);
    if (brandXml) return <SvgXml xml={brandXml} width={props.size} height={props.size} />;
    return (
        <Icon
            name={contributedIconName(props.icon) ?? 'cube'}
            size={props.size}
            color={props.color}
        />
    );
});
