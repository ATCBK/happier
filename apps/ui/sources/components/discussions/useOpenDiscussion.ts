import * as React from 'react';
import type { DiscussionAnchorV1 } from '@happier-dev/protocol/discussions';

import { useGlobalSearchParams, usePathname, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import type { DiscussionHomeAddress } from './discussionDetailsTarget';
import { buildDiscussionRouteHref, type DiscussionSourceSurface } from './discussionRoutes';

export { buildDiscussionRouteHref, buildDiscussionsRouteHref } from './discussionRoutes';

/** Home, People and Inbox open the same resource on every layout. */
export function useOpenDiscussion(input: Readonly<{
    address: DiscussionHomeAddress;
    anchor?: DiscussionAnchorV1;
    sourceSurface?: DiscussionSourceSurface;
}>): Readonly<{
    openNewDiscussion: () => void;
    openDiscussion: (discussionId: string, title?: string | null) => void;
    activeDiscussionKey: string | null;
}> {
    const router = useRouter();
    const pathname = usePathname();
    // The open Discussion is the route's: the Discussions column stands outside the route's own screen.
    const params = useGlobalSearchParams<{ serverId?: string | string[]; discussionId?: string | string[] }>();
    const { serverId } = input.address;
    const { anchor, sourceSurface } = input;
    const activeDiscussionKey = params.serverId !== serverId ? null
        : pathname === '/discussions/new' ? 'new'
        : pathname.startsWith('/discussions/') && typeof params.discussionId === 'string'
            ? params.discussionId : null;
    return React.useMemo(() => ({
        openNewDiscussion: () => router.push(buildDiscussionRouteHref({
            target: { kind: 'new', address: { serverId }, ...(anchor ? { anchor } : {}) }, sourceSurface,
        }) as Href),
        openDiscussion: (discussionId: string, _title?: string | null) => router.push(buildDiscussionRouteHref({
            target: { kind: 'discussion', address: { serverId }, discussionId }, sourceSurface,
        }) as Href),
        activeDiscussionKey,
    }), [activeDiscussionKey, anchor, router, serverId, sourceSurface]);
}
