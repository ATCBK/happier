import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet } from 'react-native-unistyles';

import { resolveSettingsNestedRouteName } from '@/components/settings/navigation/settingsRouteRegistry';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { HomeConsoleShell, HomeConsoleSidebar, useHomeConsoleNavigation } from './HomeConsoleNavigation';
import { HomePeopleCollectionRail } from './HomePeopleCollectionRail';
import { homeAdministrationOverviewPath, homeAdministrationPeoplePath } from './homeAdministrationRoutes';

const CONSOLE_NAVIGATOR = 'home/[serverId]' as const;

/**
 * The narrowest page: a person that still fits the role segmented control beside its label, and the
 * narrowest console page that keeps its rows' controls beside their labels.
 */
const CONSOLE_PAGE_MIN_WIDTH_PX = 480;

function resolveConsoleChildRoute(pathname: string): string {
    return resolveSettingsNestedRouteName(CONSOLE_NAVIGATOR, pathname) ?? 'index';
}

/** The person a console pathname is about (`…/people/<accountId>`), or `null` anywhere else. */
export function resolveSelectedHomePerson(pathname: string, peoplePath: string): string | null {
    const normalized = pathname.replace(/\/+$/, '');
    if (!normalized.startsWith(`${peoplePath}/`)) return null;
    const segment = normalized.slice(peoplePath.length + 1).split('/')[0];
    if (!segment) return null;
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}

/**
 * The Home owner console (plan §3.10, R16): one collection of pages. Its navigation is a second
 * sidebar beside the settings navigation from a 1280px window (`HomeConsoleSidebar`), a header menu
 * above the page when narrower, and on phones Overview's list, which pushes each page. While a person
 * is open, People's own rail takes the sidebar's place beside them (list + detail, lab `hcPeople-D`),
 * as a Team's Members rail takes the Teams rail's. The page stack stays mounted across every change:
 * the sidebar comes and goes beside it.
 */
export const HomeConsoleLayout = React.memo(function HomeConsoleLayout() {
    const params = useLocalSearchParams<{ serverId?: string | string[] }>();
    const serverId = Array.isArray(params.serverId) ? params.serverId[0] ?? '' : params.serverId ?? '';
    const pathname = usePathname();
    const selectedAccountId = resolveSelectedHomePerson(pathname, homeAdministrationPeoplePath(serverId));
    const peopleRail = selectedAccountId !== null;
    return (
        <HomeConsoleShell serverId={serverId} rail={peopleRail ? 'people' : 'console'}>
            <HomeConsoleFrame serverId={serverId} sidebar={!peopleRail}>
            <SettingsCollectionLayout
                navigator={CONSOLE_NAVIGATOR}
                rootPathname={homeAdministrationOverviewPath(serverId)}
                resolveChildRoute={resolveConsoleChildRoute}
                rail={peopleRail
                    ? <HomePeopleCollectionRail serverId={serverId} selectedAccountId={selectedAccountId} />
                    : null}
                railWidth="standard"
                detailMinWidthPx={CONSOLE_PAGE_MIN_WIDTH_PX}
                testID="settings-home-console"
            />
            </HomeConsoleFrame>
        </HomeConsoleShell>
    );
});

/**
 * The console sidebar beside the pages where it fits and no other rail stands there; the pages keep
 * their place either way.
 */
function HomeConsoleFrame(props: Readonly<{ serverId: string; sidebar: boolean; children: React.ReactNode }>) {
    const styles = stylesheet;
    const sidebar = useHomeConsoleNavigation() === 'sidebar' && props.sidebar;
    return (
        <View style={styles.frame}>
            {sidebar ? <HomeConsoleSidebar serverId={props.serverId} /> : null}
            <View style={styles.pages}>{props.children}</View>
        </View>
    );
}

const stylesheet = StyleSheet.create(() => ({
    frame: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
    },
    pages: {
        flex: 1,
        minWidth: 0,
        minHeight: 0,
    },
}));
