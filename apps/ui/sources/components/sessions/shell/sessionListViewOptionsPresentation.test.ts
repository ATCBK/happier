import { describe, expect, it, vi } from 'vitest';

import {
    resolveSessionListViewOptionSelectionDelta,
    resolveSessionListViewOptionsPresentation,
} from './sessionListViewOptionsPresentation';

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('session list View options presentation', () => {
    it('uses one closed choice projection for the list and Settings hosts', () => {
        const presentation = resolveSessionListViewOptionsPresentation({
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'project',
            sessionListOrderingModeV1: 'custom',
            sessionListAttentionPromotionModeV1: 'global',
            sessionListWorkingPlacementModeV1: 'withinGroups',
            sessionFolderViewModeV1: 'tree',
            sessionListFolderSortModeV1: 'mixed',
            foldersFeatureEnabled: true,
        }, 'recent_activity');

        expect(presentation.selectedLayout).toBe('recent_activity');
        expect(presentation.layoutItems.map((item) => item.id)).toEqual([
            'layout:projects',
            'layout:recent_activity',
            'layout:active_inactive',
        ]);
        expect(presentation.showSectionGrouping).toBe(false);
        expect(presentation.showProjectOrdering).toBe(false);
        expect(presentation.showFolderOptions).toBe(false);
        expect(presentation.selectedAttentionPlacement).toBe('global');
        expect(presentation.selectedWorkingPlacement).toBe('withinGroups');
    });

    it('maps every layout and placement choice to incumbent settings', () => {
        const current = {
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'activity',
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'project',
        } as const;

        expect(resolveSessionListViewOptionSelectionDelta('layout:projects', current)).toEqual({
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'project',
        });
        expect(resolveSessionListViewOptionSelectionDelta('layout:active_inactive', current)).toEqual({
            sessionListSectionModeV1: 'activity',
        });
        expect(resolveSessionListViewOptionSelectionDelta('attention:withinGroups', current)).toEqual({
            sessionListAttentionPromotionModeV1: 'withinGroups',
        });
        expect(resolveSessionListViewOptionSelectionDelta('working:off', current)).toEqual({
            sessionListWorkingPlacementModeV1: 'off',
        });
    });

    it('emits per-section grouping option ids that both hosts can apply unchanged', () => {
        const settings = {
            sessionListOrderingModeV1: 'custom',
            sessionListSectionModeV1: 'activity',
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'project',
        } as const;
        const presentation = resolveSessionListViewOptionsPresentation(settings, 'active_inactive');

        expect(presentation.showSectionGrouping).toBe(true);
        expect(presentation.activeGroupingItems.map((item) => item.id)).toEqual([
            'grouping:active:project',
            'grouping:active:date',
        ]);
        expect(presentation.inactiveGroupingItems.map((item) => item.id)).toEqual([
            'grouping:inactive:project',
            'grouping:inactive:date',
        ]);
        expect(presentation.selectedActiveGroupingId).toBe('grouping:active:date');
        expect(presentation.selectedInactiveGroupingId).toBe('grouping:inactive:project');

        for (const item of [...presentation.activeGroupingItems, ...presentation.inactiveGroupingItems]) {
            expect(resolveSessionListViewOptionSelectionDelta(item.id, settings)).not.toBeNull();
        }
    });

    it('hides folder options for both hosts when the folders feature is unavailable', () => {
        const settings = {
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'project',
            sessionFolderViewModeV1: 'tree',
        } as const;

        expect(resolveSessionListViewOptionsPresentation({ ...settings, foldersFeatureEnabled: true }, 'projects')
            .showFolderOptions).toBe(true);
        expect(resolveSessionListViewOptionsPresentation({ ...settings, foldersFeatureEnabled: false }, 'projects')
            .showFolderOptions).toBe(false);
    });

    it('describes the layout that is rendering, not the stored preference a visit intent overrides', () => {
        const savedProjects = {
            sessionListSectionModeV1: 'single',
            sessionListActiveGroupingV1: 'project',
        } as const;

        // On /session/recent the rows render Recent activity while the Account
        // still stores Projects; the menu must check what the person sees.
        const presentation = resolveSessionListViewOptionsPresentation(savedProjects, 'recent_activity');

        expect(presentation.selectedLayout).toBe('recent_activity');
        expect(presentation.showProjectOrdering).toBe(false);
    });
});
