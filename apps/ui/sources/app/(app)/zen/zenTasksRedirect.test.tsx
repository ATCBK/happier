import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readTriageEntryRouteSegmentV1 } from '@happier-dev/triage-protocol/v1';
import { renderScreen, standardCleanup } from '@/dev/testkit';

const routeState = vi.hoisted(() => ({ params: {} as Record<string, string | string[]> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routeState.params }).module;
});

afterEach(() => {
    routeState.params = {};
    standardCleanup();
});

describe('retained Zen links', () => {
    it.each(['view', 'id'])('preserves the exact selected task from %s through the public route codec', async (path) => {
        const Route = (path === 'view' ? await import('./view') : await import('./[id]')).default;
        routeState.params.id = 'task,with / unicode 界';
        const screen = await renderScreen(React.createElement(Route));
        const href = screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]?.props.href;
        expect(href).toEqual(expect.stringContaining('/plugins/happier.triage/tasks/'));
        const segment = decodeURIComponent(href.slice(href.lastIndexOf('/') + 1));
        expect(readTriageEntryRouteSegmentV1(segment)).toEqual({
            source: { pluginId: 'happier.triage', localId: 'internal' },
            kindId: 'task', collisionScope: 'personal', entryId: routeState.params.id,
        });
    });

    it.each(['./index', './new'])('opens the existing Tasks page from %s', async (path) => {
        const Route = (path === './index' ? await import('./index') : await import('./new')).default;
        const screen = await renderScreen(React.createElement(Route));
        expect(screen.findAll((node) => (node.type as unknown) === 'Redirect')[0]?.props.href)
            .toBe('/plugins/happier.triage/tasks');
    });
});
