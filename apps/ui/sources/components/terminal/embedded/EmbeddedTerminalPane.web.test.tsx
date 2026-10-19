/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { EmbeddedTerminalPaneController, EmbeddedTerminalPaneStatus } from './types';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'web', select: <T,>(values: { web?: T; default?: T }) => values.web ?? values.default } }));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The lazy xterm renderer is a platform boundary; the frame, key rail and arrow pad stay real.
vi.mock('@/components/sessions/panes/SessionPaneLazyLoader', () => ({ SessionPaneLazyLoader: () => null }));

const { EmbeddedTerminalPane } = await import('./EmbeddedTerminalPane.web');

function controller(status: EmbeddedTerminalPaneStatus): EmbeddedTerminalPaneController {
    return { status, error: null, detectedUrl: null, onInput: () => {}, onPaste: () => {}, onResize: () => {}, onReady: () => {},
        onWriteComplete: () => {}, clearTerminal: () => {}, requestRestart: () => {}, retryConnect: () => {}, dismissDetectedUrl: () => {} };
}

async function renderPane(status: EmbeddedTerminalPaneStatus) {
    return renderScreen(<KeyboardShortcutProvider handlers={{}}><PluginSurfaceFocusEligibilityProvider active>
        <EmbeddedTerminalPane title="Shell" controller={controller(status)} terminalRef={{ current: null }} chrome="none"
            showQuickKeys testIdPrefix="term" />
    </PluginSurfaceFocusEligibilityProvider></KeyboardShortcutProvider>);
}

describe('phone terminal keys', () => {
    it.each<EmbeddedTerminalPaneStatus>(['connecting', 'connected'])('are offered while a terminal is %s', async (status) => {
        const screen = await renderPane(status);
        expect(screen.findByTestId('term-key-rail')).toBeTruthy();
        await screen.unmount();
    });

    it.each<EmbeddedTerminalPaneStatus>(['not-open', 'exited', 'error'])('stay away while no terminal is open or being opened (%s)', async (status) => {
        const screen = await renderPane(status);
        expect(screen.findByTestId('term-key-rail')).toBeNull();
        await screen.unmount();
    });
});
