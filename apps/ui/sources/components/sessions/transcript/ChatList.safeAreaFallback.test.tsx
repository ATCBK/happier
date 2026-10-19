import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture, createTestSessionTranscriptSource, renderWithSessionTranscriptSource, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

let capturedHeaderSpacerHeight: number | null = null;

function unwrapStyle(style: unknown): Record<string, unknown> | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (const entry of style) {
            const resolved = unwrapStyle(entry);
            if (resolved) return resolved;
        }
        return null;
    }
    return typeof style === 'object' ? (style as Record<string, unknown>) : null;
}

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
        });
});
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () =>
    (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@legendapp/list/react-native')>();
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original, renderItems: false }).module;
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 22, bottom: 0, left: 0, right: 0 } },
}));

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('ChatList safe area', () => {
    beforeEach(() => {
        capturedHeaderSpacerHeight = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('uses a compact transcript gutter instead of chrome-safe area inside the list header', async () => {
        const { ChatList } = await import('./ChatList');

        const session = createSessionFixture({ id: 'session-1', metadata: null, active: true });
        const screen = await renderWithSessionTranscriptSource(
            <ChatList session={session} sessionSurfaceKey={JSON.stringify(['test-server', 'session-1'])} />,
            createTestSessionTranscriptSource({ sessionId: session.id, serverId: 'test-server' }),
        );
        const spacer = screen.findHostByTestId('transcript-top-gutter');
        const height = unwrapStyle(spacer?.props.style)?.height;
        capturedHeaderSpacerHeight = typeof height === 'number' ? height
            : height && typeof height === 'object' && '__getValue' in height && typeof height.__getValue === 'function'
                ? height.__getValue() : null;
        expect(capturedHeaderSpacerHeight).toBe(12);
    });
});
