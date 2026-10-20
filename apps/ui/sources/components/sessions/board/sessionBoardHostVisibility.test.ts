import { describe, expect, it } from 'vitest';

import {
    resolveSessionBoardItemPrimaryMountHost,
    resolveSessionBoardHostVisibility,
    retainSessionBoardHostVisibility,
    type SessionBoardHostVisibilityFacts,
} from './sessionBoardHostVisibility';

function facts(overrides: Partial<SessionBoardHostVisibilityFacts> = {}): SessionBoardHostVisibilityFacts {
    return {
        foreground: true,
        panes: { detailsOpen: false, mainHidden: false, rightOpen: false, rightActiveTabId: null },
        companionPlacement: { kind: 'hidden' },
        mobileSurface: null,
        ...overrides,
    };
}

describe('resolveSessionBoardHostVisibility', () => {
    it('gathers every candidate host the incumbent owners currently render', () => {
        expect(resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: true, mainHidden: false, rightOpen: true, rightActiveTabId: 'board' },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        })).visibleHosts).toEqual(['details', 'sidebar', 'companion']);
    });

    it('does not count Details while it is open on something other than the Board', () => {
        // An open Details pane showing a file mounts no Board. Counting it would
        // outrank the sidebar, leaving the executable item running nowhere while
        // the sidebar shows an inert "Open in Details" preview.
        const resolved = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: false,
                mainHidden: false,
                rightOpen: true,
                rightActiveTabId: 'board',
            },
        }));

        expect(resolved.visibleHosts).toEqual(['sidebar']);
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: resolved,
            itemVisibleInCompanion: false,
        })).toBe('sidebar');
    });

    it('does not count the sidebar while another right tab is active', () => {
        expect(resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: false, mainHidden: false, rightOpen: true, rightActiveTabId: 'git' },
        })).visibleHosts).toEqual([]);
    });

    it('counts the Companion only where it actually renders content', () => {
        expect(resolveSessionBoardHostVisibility(facts({
            companionPlacement: { kind: 'collapsed_control', edge: 'trailing', reason: 'geometry' },
        })).visibleHosts).toEqual([]);
        expect(resolveSessionBoardHostVisibility(facts({
            companionPlacement: { kind: 'mobile_control' },
        })).visibleHosts).toEqual([]);
        expect(resolveSessionBoardHostVisibility(facts({ mobileSurface: 'companion' })).visibleHosts)
            .toEqual(['companion']);
        expect(resolveSessionBoardHostVisibility(facts({ mobileSurface: 'board' })).visibleHosts)
            .toEqual(['mobileCockpit']);
    });

    it.each([
        ['board', 'mobileCockpit'],
        ['companion', 'companion'],
    ] as const)('masks retained desktop pane candidates while the mobile %s surface is active', (mobileSurface, expectedHost) => {
        const resolved = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                mainHidden: true,
                rightOpen: true,
                rightActiveTabId: 'board',
            },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
            mobileSurface,
        }));

        expect(resolved.visibleHosts).toEqual([expectedHost]);
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: resolved,
            itemVisibleInCompanion: true,
        })).toBe(expectedHost);
    });

    it('restores retained desktop candidates when the exclusive mobile surface leaves', () => {
        const retainedDesktopFacts = facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                mainHidden: false,
                rightOpen: true,
                rightActiveTabId: 'board',
            },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        });

        expect(resolveSessionBoardHostVisibility({
            ...retainedDesktopFacts,
            mobileSurface: 'board',
        }).visibleHosts).toEqual(['mobileCockpit']);
        expect(resolveSessionBoardHostVisibility({
            ...retainedDesktopFacts,
            mobileSurface: null,
        }).visibleHosts).toEqual(['details', 'sidebar', 'companion']);
    });

    it('gives focused Details keyboard focus so it wins over precedence', () => {
        const resolved = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: true, mainHidden: true, rightOpen: false, rightActiveTabId: null },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));

        expect(resolved.visibleHosts).toContain('focusedDetails');
        expect(resolved.focusedHost).toBe('focusedDetails');
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: resolved,
            itemVisibleInCompanion: true,
        })).toBe('focusedDetails');
    });

    it('resolves ONE primary host that the Companion and the sidebar agree on', () => {
        // The reachable split-brain this owner removes: the compact sidebar used
        // to self-appoint from its own visibility while the Companion resolved a
        // different winner, so one executable item mounted twice.
        const resolved = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: false, mainHidden: false, rightOpen: true, rightActiveTabId: 'board' },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));

        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: resolved,
            itemVisibleInCompanion: true,
        })).toBe('companion');
        expect(resolved.visibleHosts).toContain('sidebar');
    });

    it('resolves the primary host per item when only some Board items are in Companion', () => {
        const visibility = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: false, mainHidden: false, rightOpen: true, rightActiveTabId: 'board' },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));

        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: true,
        })).toBe('companion');
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
        })).toBe('sidebar');
    });

    it('drives no executable mount from a background window', () => {
        const visibility = resolveSessionBoardHostVisibility(facts({
            foreground: false,
            panes: { detailsOpen: true, mainHidden: false, rightOpen: false, rightActiveTabId: null },
        }));
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
        })).toBeNull();
    });

    it('resolves nothing before the pane owner has published its state', () => {
        const visibility = resolveSessionBoardHostVisibility(facts({ panes: null }));
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
        })).toBeNull();
    });

    it('runs one Details copy when a Board and an item expansion are both presented', () => {
        // Two split groups: the generic Board tab and `item-1`'s own expanded
        // destination. Both are the `details` host and both draw `item-1` at full
        // density, so "host === primaryHost" alone gave the one executable item two
        // live frames.
        const visibility = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                detailsExpandedItemIds: ['item-1'],
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
        }));

        const forDestination = (
            itemId: string,
            detailsDestinationItemId: string | null,
        ) => resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
            itemId,
            detailsDestination: { detailsDestinationItemId },
        });

        expect(forDestination('item-1', 'item-1')).toBe('details');
        expect(forDestination('item-1', null)).toBeNull();
        // Every other item keeps running in the generic destination.
        expect(forDestination('item-2', null)).toBe('details');
        expect(forDestination('item-2', 'item-1')).toBeNull();
    });

    it('hands the mount back to the Board when the expanded destination closes', () => {
        const withExpansion = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                detailsExpandedItemIds: ['item-1'],
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
        }));
        const closed = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
        }));

        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: withExpansion,
            itemVisibleInCompanion: false,
            itemId: 'item-1',
            detailsDestination: { detailsDestinationItemId: null },
        })).toBeNull();
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: closed,
            itemVisibleInCompanion: false,
            itemId: 'item-1',
            detailsDestination: { detailsDestinationItemId: null },
        })).toBe('details');
    });

    it('does not elect Details for an item no visible Details destination draws', () => {
        // Details presents ONLY `board:item-a`. It draws nothing for item B, so
        // electing `details` for B left B an inert preview with no live copy anywhere.
        const expandedOnly = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                detailsShowsGenericBoard: false,
                detailsExpandedItemIds: ['item-a'],
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: expandedOnly,
            itemVisibleInCompanion: true,
            itemId: 'item-b',
        })).toBe('companion');
        // The expanded item itself still runs in the destination opened for it.
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: expandedOnly,
            itemVisibleInCompanion: true,
            itemId: 'item-a',
        })).toBe('details');

        // Control: the generic Board grid draws every placement, so it wins again.
        const genericBoard = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                detailsShowsGenericBoard: true,
                detailsExpandedItemIds: ['item-a'],
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: genericBoard,
            itemVisibleInCompanion: true,
            itemId: 'item-b',
        })).toBe('details');
    });

    it('keeps focused Details from winning for an item it does not draw', () => {
        const visibility = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: true,
                detailsShowsGenericBoard: false,
                detailsExpandedItemIds: ['item-a'],
                mainHidden: true,
                rightOpen: true,
                rightActiveTabId: 'board',
            },
        }));
        expect(visibility.focusedHost).toBe('focusedDetails');
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: false,
            itemId: 'item-b',
        })).toBe('sidebar');
    });

    it('keeps a non-Details placement out of the destination selection', () => {
        // The Companion renders its own ordered subset, so an expanded Details
        // destination must not silently retire it.
        const visibility = resolveSessionBoardHostVisibility(facts({
            panes: {
                detailsOpen: true,
                detailsShowsBoard: false,
                detailsExpandedItemIds: ['item-1'],
                mainHidden: false,
                rightOpen: false,
                rightActiveTabId: null,
            },
            companionPlacement: { kind: 'reserved_rail', edge: 'trailing', widthPx: 280 },
        }));

        expect(visibility.detailsExpandedItemIds).toEqual([]);
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility,
            itemVisibleInCompanion: true,
            itemId: 'item-1',
        })).toBe('companion');
    });
});

// The hook re-derives visibility on every render; its value keys the Board placement resolver that
// the Session pane driver registers with. A fresh-but-equal visibility re-registered the driver on
// every render, the registry update re-rendered the Session view, and opening a Session looped
// ("Maximum update depth exceeded").
describe('inline transcript candidacy', () => {
    const boardSidebar = resolveSessionBoardHostVisibility(facts({
        panes: { detailsOpen: false, mainHidden: false, rightOpen: true, rightActiveTabId: 'board' },
    }));
    const nothingOnScreen = resolveSessionBoardHostVisibility(facts());

    it('runs a transcript visual in its reply when no Board host draws it', () => {
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: nothingOnScreen, itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: false, inlineTranscriptDemanded: true },
        })).toBe('inlineTranscript');
    });

    it('keeps the one live body on a visible Board host for an item shown in both places', () => {
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: boardSidebar, itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: true, inlineTranscriptDemanded: true },
        })).toBe('sidebar');
    });

    it('hands the one live body to the reply the person asked to show it here, over a visible Board host', () => {
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: boardSidebar, itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: true, inlineTranscriptDemanded: true, inlineTranscriptPreferred: true },
        })).toBe('inlineTranscript');
        // A preference with no reply on screen runs nothing in the transcript.
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: boardSidebar, itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: true, inlineTranscriptDemanded: false, inlineTranscriptPreferred: true },
        })).toBe('sidebar');
    });

    it('elects no reply when no reply that draws the item is on screen', () => {
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: nothingOnScreen, itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: false, inlineTranscriptDemanded: false },
        })).toBeNull();
        expect(resolveSessionBoardItemPrimaryMountHost({
            visibility: resolveSessionBoardHostVisibility(facts({ foreground: false })),
            itemVisibleInCompanion: false, itemId: 'visual',
            boardView: { drawnBySelectedBoardView: false, inlineTranscriptDemanded: true },
        })).toBeNull();
    });
});

describe('retainSessionBoardHostVisibility', () => {
    it('keeps the previous visibility when the next one says the same thing', () => {
        const previous = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: true, mainHidden: false, rightOpen: false, rightActiveTabId: null, detailsExpandedItemIds: ['a'] },
        }));
        const next = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: true, mainHidden: false, rightOpen: false, rightActiveTabId: null, detailsExpandedItemIds: ['a'] },
        }));
        expect(next).not.toBe(previous);
        expect(retainSessionBoardHostVisibility(previous, next)).toBe(previous);
    });

    it('takes the next visibility when anything changed', () => {
        const previous = resolveSessionBoardHostVisibility(facts());
        const hidden = resolveSessionBoardHostVisibility(facts({ foreground: false }));
        const sidebar = resolveSessionBoardHostVisibility(facts({
            panes: { detailsOpen: false, mainHidden: false, rightOpen: true, rightActiveTabId: 'board' },
        }));
        expect(retainSessionBoardHostVisibility(previous, hidden)).toBe(hidden);
        expect(retainSessionBoardHostVisibility(previous, sidebar)).toBe(sidebar);
        expect(retainSessionBoardHostVisibility(null, previous)).toBe(previous);
    });
});
