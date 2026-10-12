import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const useArtifactsLoaded = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({ pathname: '/settings/prompts', screenOptions: null as null | Record<string, unknown> }));

// expo-router is the navigation boundary: record what the layout asks its settings-stack screen to show.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ pathname: () => routerState.pathname });
    return {
        ...boundary.module,
        Slot: () => React.createElement('PromptRouteSlot'),
        Stack: {
            ...boundary.module.Stack,
            Screen: (props: { options?: Record<string, unknown> }) => {
                routerState.screenOptions = props.options ?? null;
                return null;
            },
        },
    };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({ ActivitySpinner: 'ActivitySpinner' }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => (await import('@/dev/testkit/mocks/storage'))
    .createStorageModuleMock({ importOriginal, overrides: { useArtifactsLoaded } }));

describe('PromptsLayoutRoute', () => {
    beforeEach(() => {
        useArtifactsLoaded.mockReset();
        routerState.pathname = '/settings/prompts';
        routerState.screenOptions = null;
    });

    it.each([
        ['/settings/prompts/skills', 'promptLibrary.skills'],
        ['/settings/prompts/templates', 'promptLibrary.templates'],
        ['/settings/prompts/docs/doc-1', 'promptLibrary.editPrompt'],
        ['/settings/prompts', 'settings.prompts'],
    ] as const)('titles the phone header for %s from the route registry', async (pathname, titleKey) => {
        useArtifactsLoaded.mockReturnValue(true);
        routerState.pathname = pathname;
        const { t } = await import('@/text');
        const { default: PromptsLayoutRoute } = await import('./_layout');
        await renderScreen(<PromptsLayoutRoute />);

        expect(routerState.screenOptions?.headerTitle).toBe(t(titleKey));
    });

    it('keeps every prompt route unmounted until artifact heads are materialized', async () => {
        useArtifactsLoaded.mockReturnValue(false);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findByTestId('prompts.artifacts.loading')).toBeTruthy();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
    });

    it('mounts the selected prompt route after artifact heads are ready', async () => {
        useArtifactsLoaded.mockReturnValue(true);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1);
    });
});
