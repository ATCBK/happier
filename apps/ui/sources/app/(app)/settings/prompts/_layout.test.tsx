import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

const useArtifactsLoaded = vi.hoisted(() => vi.fn());
const fetchArtifactsList = vi.hoisted(() => vi.fn());
const routerState = vi.hoisted(() => ({ pathname: '/settings/prompts', screenOptions: null as null | Record<string, unknown>,
    params: {} as Record<string, string | string[]> }));

// expo-router is the navigation boundary: record what the layout asks its settings-stack screen to show.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ pathname: () => routerState.pathname, params: () => routerState.params });
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
// The sync engine's inventory read is the network boundary: the layout reads it while the inventory is unknown.
vi.mock('@/sync/sync', () => ({ sync: { fetchArtifactsList } }));
vi.mock('@/sync/domains/state/storage', async (importOriginal) => (await import('@/dev/testkit/mocks/storage'))
    .createStorageModuleMock({ importOriginal, overrides: { useArtifactsLoaded } }));

describe('PromptsLayoutRoute', () => {
    beforeEach(() => {
        useArtifactsLoaded.mockReset();
        fetchArtifactsList.mockReset();
        fetchArtifactsList.mockResolvedValue(undefined);
        routerState.pathname = '/settings/prompts';
        routerState.screenOptions = null;
        routerState.params = {};
    });

    it.each([
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

    it('says when the inventory read fails and Retry reads it again, instead of spinning forever', async () => {
        useArtifactsLoaded.mockReturnValue(false);
        fetchArtifactsList.mockRejectedValueOnce(new Error('Failed to fetch'));
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);
        await act(async () => {});

        expect(screen.findByTestId('prompts.artifacts.loading')).toBeNull();
        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(0);
        const failed = screen.findAll(node => node.props.testID === 'prompts.artifacts.failed' && node.props.action !== undefined)[0]!;
        expect(failed.props.action.label).toBe('Retry');

        await act(async () => { failed.props.action.onPress(); });
        expect(fetchArtifactsList).toHaveBeenCalledTimes(2);
        // The retry succeeded: the failed state is gone while the inventory is still being published.
        expect(screen.findByTestId('prompts.artifacts.failed')).toBeNull();
        expect(screen.findByTestId('prompts.artifacts.loading')).toBeTruthy();
    });

    it('does not read the inventory itself once it is loaded', async () => {
        useArtifactsLoaded.mockReturnValue(true);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        await renderScreen(<PromptsLayoutRoute />);
        expect(fetchArtifactsList).not.toHaveBeenCalled();
    });

    it('mounts the selected prompt route after artifact heads are ready', async () => {
        useArtifactsLoaded.mockReturnValue(true);
        const { default: PromptsLayoutRoute } = await import('./_layout');
        const screen = await renderScreen(<PromptsLayoutRoute />);

        expect(screen.findAllByType('PromptRouteSlot' as never)).toHaveLength(1);
    });

    it.each([
        ['./skills/index', '/settings/skills', {}],
        ['./skills/new', '/settings/skills/new', {}],
        ['./skills/[id]', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/export', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/files/edit', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./skills/[id]/files/new', '/settings/skills/[skillId]', { skillId: 'skill/one' }],
        ['./assets', '/settings/skills/found', {}],
        ['./registries', '/settings/skills', { add: 'browse' }],
        ['./registries/item', '/settings/skills', { add: 'browse' }],
    ] as const)('retains the selected Home and item identity through legacy route %s', async (path, pathname, params) => {
        routerState.params = { id: ['skill/one', 'ignored'], serverId: ['home one', 'ignored'] };
        const { WorkspaceRouteBody } = await import(path);
        const screen = await renderScreen(<WorkspaceRouteBody />);
        const href = screen.findAllByType('Redirect' as never)[0]?.props.href;
        expect(href).toEqual({ pathname, params: { ...params, serverId: 'home one' } });
    });

    it('redirects a retired document export to that document on its selected Home', async () => {
        routerState.params = { id: ['doc/one', 'ignored'], serverId: ['home one', 'ignored'],
            assetTypeId: 'claude.command', scope: 'project', workspacePath: '/old-target' };
        const { WorkspaceRouteBody } = await import('./docs/[id]/export');
        const screen = await renderScreen(<WorkspaceRouteBody />);
        expect(screen.findAllByType('Redirect' as never)[0]?.props.href)
            .toEqual({ pathname: '/settings/prompts/docs/[id]', params: { id: 'doc/one', serverId: 'home one' } });
    });
});
