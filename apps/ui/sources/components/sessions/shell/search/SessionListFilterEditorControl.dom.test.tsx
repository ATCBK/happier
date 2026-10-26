/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: () => vi.importActual('react-native-web') });

const { SessionListFilterEditorControl } = await import('./SessionListFilterEditorControl');
const { buildSessionListFilterEditorLabels } = await import('./SessionListFilterControl');
const { createSessionListViewFilterDefaults } = await import('./sessionListViewFilters');

describe('Session filter navigation request', () => {
    it('opens the existing shared editor after accepted navigation', async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const onOpenRequestHandled = vi.fn();
        const editor = {
            filters: createSessionListViewFilterDefaults({ homeServerIds: ['home-a'] }), includeInactive: true,
            queryEnabled: false, followingAvailable: false, sourceAvailable: false,
            homes: [{ serverId: 'home-a', label: 'Home A' }], audiences: [], tags: [],
            labels: buildSessionListFilterEditorLabels(), updateFilters: () => {}, setIncludeInactive: () => {},
            setSource: () => {}, resetFilters: () => {}, removeAuthoritativelyDeletedSelections: () => {},
        };
        try {
            await act(async () => root.render(<SessionListFilterEditorControl label="My work" active keyboardEnabled={false}
                editor={editor} openRequested={false} onOpenRequestHandled={onOpenRequestHandled} />));
            expect(container.querySelector('[data-testid="session-list-filter-trigger"]')?.getAttribute('aria-expanded')).toBe('false');
            await act(async () => root.render(<SessionListFilterEditorControl label="My work" active keyboardEnabled={false}
                editor={editor} openRequested onOpenRequestHandled={onOpenRequestHandled} />));
            expect(container.querySelector('[data-testid="session-list-filter-trigger"]')?.getAttribute('aria-expanded')).toBe('true');
            expect(onOpenRequestHandled).toHaveBeenCalled();
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
});
