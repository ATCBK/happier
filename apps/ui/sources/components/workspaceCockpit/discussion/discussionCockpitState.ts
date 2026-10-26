/**
 * A phone's Discussion surfaces: the thread (`chat`) and the surfaces its rail tabs declare
 * (`mobileSurfaces.discussion`), the same projection a Session's and a Project's phone bar read.
 */
export type DiscussionMobileSurface = 'chat' | 'participants' | 'agents' | 'details';

export function normalizeDiscussionMobileSurface(value: string | null | undefined): DiscussionMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized === 'chat' || normalized === 'participants' || normalized === 'agents' || normalized === 'details' ? normalized : null;
}

/** `/discussions/<id>` with its `mobileSurface` search param; a new Discussion has no surfaces yet. */
export function resolveDiscussionCockpitRouteFromPathname(
    pathname: string,
    surfaceHint: string | null | undefined,
): Readonly<{ discussionId: string; surface: DiscussionMobileSurface }> | null {
    const match = /^\/discussions\/([^/?#]+)\/?$/.exec(pathname);
    const discussionId = match ? decodeURIComponent(match[1] ?? '') : '';
    if (!discussionId || discussionId === 'new') return null;
    return { discussionId, surface: normalizeDiscussionMobileSurface(surfaceHint) ?? 'chat' };
}
