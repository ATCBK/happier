import * as React from 'react';

import { BotsEntrySummary } from '@/components/sessions/bots/BotsEntrySummary';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveNavigationPlacements, type NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { destinationRowTestId, useColumnDestinations } from '@/components/appShell/destinations/ColumnDestinationRows';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { SEARCH_DESTINATION_ID, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';

/**
 * What the phone's shortcuts pin before anyone customizes them: Search finds anything, Bots carries what
 * needs you, Workflows and Artifacts are what a phone is used to check. Everything else follows under a
 * hairline (More) until pinned.
 */
const PHONE_LAUNCHER_DEFAULT_PINNED_IDS: ReadonlySet<string> = new Set([SEARCH_DESTINATION_ID, 'workflows', 'artifacts', 'bots']);
const CUSTOMIZE_ITEM_ID = 'phone-launcher:customize';
/** Half the 2 px gap to the header glyph before it; the full 8 px past its drawn square on the free side. */
const PHONE_HEADER_GLYPH_EDGES_PX = { leading: 1, trailing: 8 } as const;

function phoneLauncherDefaultPlacement(destination: CompactAppDestination): NavigationPlacement {
    return PHONE_LAUNCHER_DEFAULT_PINNED_IDS.has(destination.id) ? 'pinned' : 'overflow';
}

/**
 * The phone's way to every destination its tab bar does not show (calm-shell `clviews:recentP`: the Sessions
 * tab opens straight on My work, so these live behind one header control instead of a card above the list).
 * Pinned shortcuts lead, the rest follow under a hairline, then Customize — the same Pinned / More / Hidden
 * placements (device-local) the launcher always had. Rows, availability and activation come from the one
 * destination catalog.
 */
export const PhoneDestinationsMenu = React.memo(function PhoneDestinationsMenu() {
    const { destinations, currentId, activate } = useColumnDestinations(undefined);
    const placement = useNavigationSurfacePlacement('phoneLauncher');
    const [open, setOpen] = React.useState(false);
    const placed = React.useMemo(() => resolveNavigationPlacements(destinations.map((destination) => ({
        id: destination.id, destination, defaultPlacement: phoneLauncherDefaultPlacement(destination),
    })), placement.preferences), [destinations, placement.preferences]);

    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        // A shortcut in More is dimmed when unavailable and does not repeat why; a pinned one the person
        // chose keeps its reason.
        const item = (destination: CompactAppDestination, category: string): DropdownMenuItem => ({
            id: destination.id,
            testID: destinationRowTestId(destination),
            title: destination.title,
            category,
            subtitle: category === 'pinned' && destination.kind === 'plugin' && destination.availability === 'unavailable'
                ? resolveReasonCopy({ reasonCode: destination.unavailableReason, kind: 'pluginRuntime' }).message
                : undefined,
            icon: <Icon name={destination.icon} />,
            rightElement: destination.kind === 'plugin' && destination.badge
                ? <CompactAppDestinationBadge destination={destination} />
                // The phone's one Bots entry carries the faces and what needs you (lab b-rail Ap).
                : destination.activation === 'botsRoster' ? <BotsEntrySummary /> : undefined,
            checked: destination.id === currentId,
            disabled: destination.availability !== 'available',
        });
        return [
            ...placed.pinned.map((entry) => item(entry.destination, 'pinned')),
            ...placed.overflow.map((entry) => item(entry.destination, 'more')),
            { id: CUSTOMIZE_ITEM_ID, testID: 'phone-launcher-customize', title: t('navigationPlacement.customize'),
                category: 'customize', icon: <Icon name="sliders-horizontal" /> },
        ];
    }, [currentId, placed]);

    const select = React.useCallback((id: string) => {
        setOpen(false);
        if (id === CUSTOMIZE_ITEM_ID) {
            const customizable = destinations.map((destination) => ({
                id: destination.id, title: destination.title, icon: destination.icon,
                defaultPlacement: phoneLauncherDefaultPlacement(destination),
            }));
            fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
                Modal.show({ component: NavigationPlacementCustomizer,
                    props: { surfaceId: 'phoneLauncher', items: customizable, testID: 'phone-launcher-customizer' } });
            }), { tag: 'PhoneDestinationsMenu.customize' });
            return;
        }
        const destination = destinations.find((candidate) => candidate.id === id);
        if (!destination || destination.availability !== 'available') return;
        const scope = captureActiveServerAccountScopeLifetime()?.scope ?? null;
        activate(destination, { searchScope: scope ? {
            accountId: scope.accountId, serverId: scope.serverId, sessionId: null, machineId: null, rootPath: null,
        } : undefined });
    }, [activate, destinations]);

    if (destinations.length === 0) return null;
    return (
        <DropdownMenu
            testID="phone-launcher-menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={select}
            separateCategories
            // A touch menu opens with nothing highlighted, so Search does not look chosen.
            allowEmptySelection
            placement="bottom"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={280}
            popoverPortalWebTarget="body"
            popoverAccessibilityLabel={t('navigationPlacement.phoneLauncher')}
            trigger={({ toggle }) => (
                <IconButton
                    testID="phone-launcher-button"
                    iconName="grid-four"
                    // The same glyph size as the Activity glyph beside it in the phone header.
                    iconSize={ICON_SIZE.md}
                    accessibilityLabel={t('navigationPlacement.phoneLauncher')}
                    variant="plain"
                    // The last glyph of the header: it splits the 2 px gap to the glyph before it, and the header's
                    // edge padding leaves its other side free.
                    interactiveTargetEdgesPx={PHONE_HEADER_GLYPH_EDGES_PX}
                    onPress={toggle}
                />
            )}
        />
    );
});
