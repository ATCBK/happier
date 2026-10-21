import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

import { FilePageInfoDialog } from './FilePageInfoDialog';
import { useFilePageDetailsActions } from './useFilePageDetailsActions';

afterEach(standardCleanup);

describe('File Info decoding facts', () => {
    it.each([false, true])('renders the saved-byte decoding metadata without inventing an encoding (%s)', async nonUtf8 => {
        const hook = await renderHook(() => useFilePageDetailsActions({
            path: 'docs/note.txt', kind: 'text', language: 'text', content: {
                content: 'note\n', isBinary: false,
                encoding: { hasBom: false, editable: !nonUtf8, eol: 'lf', mixedEol: false,
                    ...(nonUtf8 ? { reason: 'notUtf8' as const } : {}) },
            },
        }));
        const screen = await renderScreen(<FilePageInfoDialog facts={hook.getCurrent().info} onClose={() => {}} />);
        expect(screen.findByTestId('file-info-dialog')).not.toBeNull();
        if (nonUtf8) expect(screen.findByTestId('file-info-encoding')).not.toBeNull();
        else expect(screen.findByTestId('file-info-encoding')).toBeNull();
        await hook.unmount();
    });
});
