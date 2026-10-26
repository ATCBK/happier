import { resolveRightSidebarMobileProjection } from '@/components/appShell/rightSidebar/rightSidebarMobileProjection';
import { resolveRightSidebarTabs } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import type { DiscussionRightSidebarTabId } from '@/components/discussions/discussionRightSidebarPanels';

import { normalizeDiscussionMobileSurface, type DiscussionMobileSurface } from './discussionCockpitState';

export type DiscussionMobileSurfaceEntry = Readonly<{
    surface: Exclude<DiscussionMobileSurface, 'chat'>;
    tabId: DiscussionRightSidebarTabId;
    tab: RightSidebarTabDefinition;
}>;

function isDiscussionTabId(id: string): id is DiscussionRightSidebarTabId {
    return id === 'discussionParticipants' || id === 'discussionAgents' || id === 'discussionDetails';
}

/** The Discussion rail's tabs in rail order, each with the phone surface it declares (`mobileSurfaces.discussion`). */
export function resolveDiscussionMobileSurfaces(): readonly DiscussionMobileSurfaceEntry[] {
    return resolveRightSidebarMobileProjection({ scope: 'discussion', tabs: resolveRightSidebarTabs({ scope: 'discussion' }) })
        .flatMap((entry) => {
            const surface = normalizeDiscussionMobileSurface(entry.surface);
            return surface && surface !== 'chat' && isDiscussionTabId(entry.tabId) ? [{ surface, tabId: entry.tabId, tab: entry.tab }] : [];
        });
}
