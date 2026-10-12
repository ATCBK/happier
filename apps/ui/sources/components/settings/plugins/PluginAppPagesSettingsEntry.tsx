import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import {
    type CompactAppPluginDestination,
    useActivateAppDestination,
    useCompactAppDestinations,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

/**
 * Settings consumer of the host-owned compact App catalog (EU-5b).
 *
 * This remains a convenience discovery surface, not a second page registry:
 * ordering, availability, identity and routes all come from the compact catalog.
 * The existing route/launch owner still clears staged input and mounts the page.
 */
export function PluginAppPagesSettingsEntry(): React.ReactElement | null {
    const { theme } = useUnistyles();
    const activate = useActivateAppDestination();
    const compactDestinations = useCompactAppDestinations();
    // This is the management surface for the same catalog, so hidden entries
    // stay here for recovery; ordinary discovery surfaces filter them instead.
    const pages = React.useMemo(() => compactDestinations.filter(
        (destination): destination is CompactAppPluginDestination => (
            destination.kind === 'plugin' && destination.container === 'appPage'
        ),
    ), [compactDestinations]);

    // One cause is said once: when every unavailable page is unavailable for the same reason, the section
    // says it and the rows stay dimmed; different reasons stay on their own rows.
    const reasonOf = (page: CompactAppPluginDestination) => resolveReasonCopy({
        reasonCode: page.unavailableReason,
        kind: 'pluginRuntime',
    }).message;
    const unavailableReasons = [...new Set(pages.filter((page) => page.availability === 'unavailable').map(reasonOf))];
    const sharedReason = pages.filter((page) => page.availability === 'unavailable').length > 1 && unavailableReasons.length === 1
        ? unavailableReasons[0]!
        : null;

    if (pages.length === 0) {
        return null;
    }

    return (
        <ItemGroup
            title={t('pluginSurfaces.appPage.title')}
            description={sharedReason
                ? `${t('pluginSurfaces.appPage.subtitle')} ${sharedReason}`
                : t('pluginSurfaces.appPage.subtitle')}
        >
            {pages.map((page) => (
                <Item
                    key={page.id}
                    testID={`settings.plugins.appPages.${page.id}`}
                    title={page.title}
                    // An available page is named by its title; only an unavailable one says why.
                    subtitle={page.availability === 'unavailable' && sharedReason === null ? reasonOf(page) : undefined}
                    disabled={page.availability !== 'available'}
                    icon={(
                        <Icon
                            name={page.icon}
                            size={20}
                            color={theme.colors.text.secondary}
                        />
                    )}
                    rightElement={page.badge ? <CompactAppDestinationBadge destination={page} /> : undefined}
                    keepChevronWithRightElement
                    onPress={() => activate(page)}
                />
            ))}
        </ItemGroup>
    );
}
