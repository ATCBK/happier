import {
    resolveSessionBoardPrimaryMountHost,
    type SessionBoardMountHost,
} from '@/sync/domains/session/board';

import type { SessionCompanionPlacement } from '@/components/sessions/companion/layout/resolveSessionCompanionPlacement';

import { SESSION_BOARD_DESTINATION } from './sessionBoardDestination';

/**
 * The ONE place a Session shell answers "which placement runs this item".
 *
 * V1 gives an executable item exactly one interactive placement per viewer and
 * window. Before this owner existed, four surfaces answered that question from
 * their own partial view — the compact sidebar and the Details renderer
 * self-appointed from local visibility while the Companion ran the precedence
 * resolver over a host set that did not include them. With a Board tab open in
 * the right pane AND a Companion rail visible, the sidebar called itself primary
 * and the Companion also called itself primary: one item, two live mounts.
 *
 * The fix is not another arbiter. It is gathering the complete candidate set from
 * the incumbent pane, Cockpit and Companion owners ONCE and invoking the existing
 * pure precedence resolver with it. Nothing is stored, leased or persisted.
 */

export type SessionBoardPaneVisibilityFacts = Readonly<{
    detailsOpen: boolean;
    /**
     * A Board destination is the ACTIVE tab of some Details group. An open Details
     * pane showing a file or a diff mounts no Board, so it is not a candidate.
     * Omitted keeps the previous, coarser reading for callers that cannot yet
     * supply the exact fact.
     */
    detailsShowsBoard?: boolean;
    /**
     * A GENERIC Board destination (the view grid, not one item's expanded tab) is the
     * active tab of some visible Details group. Only that destination can draw an
     * arbitrary item, so it is what makes Details a candidate host for one.
     */
    detailsShowsGenericBoard?: boolean;
    /**
     * Items whose own `board:<itemId>` destination is the active tab of a visible
     * Details group. The generic Board tab and an expanded destination are both
     * `details`, so this is what distinguishes the two physical copies.
     */
    detailsExpandedItemIds?: readonly string[];
    /** Incumbent pane focus mode, which is also what selects the focused Details renderer. */
    detailsFocusModeActive: boolean;
    rightOpen: boolean;
    rightActiveTabId: string | null;
}>;

export type SessionBoardHostVisibilityFacts = Readonly<{
    /** The window/app is foreground. A background window drives no executable mount. */
    foreground: boolean;
    /** `null` until the incumbent pane owner has published this scope's state. */
    panes: SessionBoardPaneVisibilityFacts | null;
    /** The resolved viewer-local Companion placement, from its one layout owner. */
    companionPlacement: SessionCompanionPlacement;
    /**
     * The mobile Cockpit's current Session surface, when this shell IS the
     * Cockpit. Desktop/tablet shells pass `null`.
     */
    mobileSurface: 'board' | 'companion' | null;
}>;

export type SessionBoardHostVisibility = Readonly<{
    foreground: boolean;
    visibleHosts: readonly SessionBoardMountHost[];
    focusedHost: SessionBoardMountHost | null;
    /** Items whose expanded Details destination is on screen, from the typed groups. */
    detailsExpandedItemIds: readonly string[];
    /** A generic Board destination is on screen, so Details can draw an arbitrary item. */
    detailsShowsGenericBoard: boolean;
}>;

/** The Details placement asking which copy of an item physically runs. */
export type SessionBoardDetailsDestination = Readonly<{
    /** The expanded item this destination is, or `null` for the generic Board tab. */
    detailsDestinationItemId: string | null;
}>;

/**
 * What the mounted Board controller knows about one item's place in the Board the
 * viewer is looking at. The generic Board hosts (the Details grid, the compact
 * sidebar, the mobile Board) all draw the controller's ONE selected view plus its
 * unplaced recovery items, so an item outside that set is drawn by none of them.
 */
export type SessionBoardItemBoardViewFacts = Readonly<{
    drawnBySelectedBoardView: boolean;
    /** Generic Board surfaces whose existing body window actually builds this item. */
    bodyEligibleHosts?: readonly SessionBoardMountHost[];
    /**
     * A transcript reply that draws this item has content demand from the transcript list's own
     * visibility owner. The transcript is then a candidate, ranked last: a visible Board host
     * that draws the item keeps its one live body, otherwise the reply runs it.
     */
    inlineTranscriptDemanded?: boolean;
    /**
     * The person asked this item to run in its transcript reply ("Show here"). While a reply that
     * draws it is on screen, that is the one live body and every Board host previews it; opening it
     * on a Board host releases the request.
     */
    inlineTranscriptPreferred?: boolean;
}>;

/** Publishes physical body-window facts, never a primary-host decision. */
export type SessionBoardBodyEligibilityReporter = (
    host: SessionBoardMountHost,
    viewId: string,
    itemIds: ReadonlySet<string>,
) => () => void;

/**
 * The resolver the mounted Session shell hands to every Board placement.
 *
 * Details placements also say WHICH destination is asking, because two of them can
 * be visible at once and both are the `details` host. The mounted Board controller
 * adds whether its selected view draws the item at all (see
 * {@link SessionBoardItemBoardViewFacts}); a caller that omits it is a Board
 * placement asking about an item it is drawing.
 */
export type SessionBoardPlacementPrimaryMountResolver = (
    itemId: string,
    destination?: SessionBoardDetailsDestination,
    boardView?: SessionBoardItemBoardViewFacts,
) => SessionBoardMountHost | null;


export function resolveSessionBoardHostVisibility(
    facts: SessionBoardHostVisibilityFacts,
): SessionBoardHostVisibility {
    // Board and Companion are exclusive full-screen Cockpit surfaces. Their
    // content is mounted through SessionView's contentOverride while the normal
    // AppPaneScopeHost tree is skipped, so retained desktop pane/preferences are
    // restoration state rather than physical candidates. Mask them here at the
    // shared visibility owner instead of closing panes or teaching the primary
    // resolver about mobile presentation.
    if (facts.mobileSurface) {
        const mobileHost: SessionBoardMountHost = facts.mobileSurface === 'board'
            ? 'mobileCockpit'
            : 'companion';
        return Object.freeze({
            foreground: facts.foreground,
            visibleHosts: Object.freeze([mobileHost]),
            focusedHost: null,
            detailsExpandedItemIds: Object.freeze([]),
            detailsShowsGenericBoard: false,
        });
    }

    const visibleHosts: SessionBoardMountHost[] = [];
    let detailsRendersBoard = false;

    if (facts.panes) {
        detailsRendersBoard = facts.panes.detailsOpen
            && (facts.panes.detailsShowsBoard ?? true);
        if (detailsRendersBoard) visibleHosts.push('details');
        if (detailsRendersBoard && facts.panes.detailsFocusModeActive) visibleHosts.push('focusedDetails');
        if (facts.panes.rightOpen && facts.panes.rightActiveTabId === SESSION_BOARD_DESTINATION.id) {
            visibleHosts.push('sidebar');
        }
    }

    // Only a reserved rail actually renders item content; the collapsed control
    // and the phone entry point render an affordance, so they are not candidates.
    if (facts.companionPlacement.kind === 'reserved_rail') visibleHosts.push('companion');
    const focusedHost: SessionBoardMountHost | null = visibleHosts.includes('focusedDetails')
        ? 'focusedDetails'
        : null;

    return Object.freeze({
        foreground: facts.foreground,
        visibleHosts: Object.freeze(visibleHosts),
        focusedHost,
        detailsExpandedItemIds: Object.freeze(
            detailsRendersBoard ? [...(facts.panes?.detailsExpandedItemIds ?? [])] : [],
        ),
        detailsShowsGenericBoard: detailsRendersBoard
            && (facts.panes?.detailsShowsGenericBoard ?? true),
    });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The previous visibility when `next` says the same thing, else `next`. Visibility is re-derived on
 * every render and keys the Board placement resolver (and through it the Session pane driver
 * registration), so an equal value must keep its reference.
 */
export function retainSessionBoardHostVisibility(
    previous: SessionBoardHostVisibility | null,
    next: SessionBoardHostVisibility,
): SessionBoardHostVisibility {
    if (
        previous
        && previous.foreground === next.foreground
        && previous.focusedHost === next.focusedHost
        && previous.detailsShowsGenericBoard === next.detailsShowsGenericBoard
        && sameStrings(previous.visibleHosts, next.visibleHosts)
        && sameStrings(previous.detailsExpandedItemIds, next.detailsExpandedItemIds)
    ) {
        return previous;
    }
    return next;
}

/**
 * Resolve the executable placement for one exact item.
 *
 * Board-like hosts render the selected Board view, while Companion renders only
 * the viewer's ordered local subset. Treating Companion as visible for every
 * Board item can therefore select a host that does not render the item at all,
 * leaving the real Board copy as an inert preview. The membership bit comes from
 * the canonical Companion preference; this function remains a pure projection
 * over the incumbent visibility owners and stores nothing.
 */
export function resolveSessionBoardItemPrimaryMountHost(input: Readonly<{
    visibility: SessionBoardHostVisibility;
    itemVisibleInCompanion: boolean;
    /** The exact item; only a Details placement needs it. */
    itemId?: string;
    /**
     * Which Details destination is asking: the item it expands, or `null` for the
     * generic Board tab. Omitted by every non-Details placement, which keeps the
     * host answer as it was.
     */
    detailsDestination?: SessionBoardDetailsDestination;
    /** Omitted means the asking Board placement draws the item itself. */
    boardView?: SessionBoardItemBoardViewFacts;
}>): SessionBoardMountHost | null {
    // The generic Board hosts draw only the selected view (plus unplaced recovery
    // items). An item placed only in another view is drawn by none of them, so none
    // of them can be its live copy — electing one left a visible Companion item inert.
    const genericBoardDrawsItem = input.boardView?.drawnBySelectedBoardView ?? true;
    const genericBodyEligible = (host: SessionBoardMountHost) => genericBoardDrawsItem
        && (input.boardView?.bodyEligibleHosts?.includes(host) ?? true);
    // Details is a candidate for THIS item only when a destination that actually draws
    // it is on screen: the generic Board grid, or the item's own expanded tab. A
    // Details pane presenting only `board:item-a` renders nothing for item B, so
    // electing it there left B an inert preview with no live copy anywhere.
    const visibleHosts = input.visibility.visibleHosts.filter((host) => {
        if (host === 'companion') return input.itemVisibleInCompanion;
        if (host === 'details' || host === 'focusedDetails') return input.itemId === undefined
            || (input.visibility.detailsShowsGenericBoard && genericBodyEligible(host))
            || input.visibility.detailsExpandedItemIds.includes(input.itemId);
        return genericBodyEligible(host);
    });
    const focusedHost = input.visibility.focusedHost !== null
        && visibleHosts.includes(input.visibility.focusedHost)
        ? input.visibility.focusedHost
        : null;
    const inlineTranscriptDemanded = input.boardView?.inlineTranscriptDemanded === true;
    const inlineTranscriptPreferred = inlineTranscriptDemanded
        && input.boardView?.inlineTranscriptPreferred === true;
    const host = resolveSessionBoardPrimaryMountHost({
        foreground: input.visibility.foreground,
        visibleHosts: inlineTranscriptDemanded ? [...visibleHosts, 'inlineTranscript'] : visibleHosts,
        focusedHost: inlineTranscriptPreferred ? 'inlineTranscript' : focusedHost,
    });
    if (host !== 'details' && host !== 'focusedDetails') return host;
    const destination = input.detailsDestination;
    if (!destination || input.itemId === undefined) return host;
    // Two Details destinations are both the `details` host, and both draw the item
    // at full density. The item's own expanded destination is the one a person
    // opened FOR it, so it runs and the generic Board tab previews the same item;
    // close it and the generic tab takes the mount straight back.
    if (destination.detailsDestinationItemId !== null) {
        return destination.detailsDestinationItemId === input.itemId ? host : null;
    }
    return input.visibility.detailsExpandedItemIds.includes(input.itemId) ? null : host;
}
