import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { LocalDateTimeEditor } from './LocalDateTimeEditor';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Use Metro's web platform selection, retaining the actual picker and editor.
vi.mock('./DateTimePickerPopover', () => vi.importActual('./DateTimePickerPopover.web'));

describe('LocalDateTimeEditor on web', () => {
    it('keeps calendar and time affordances alongside manual editing without a native SDK', async () => {
        function Harness() {
            const [value, setValue] = React.useState({ date: '2026-09-10', time: '09:25' });
            return <LocalDateTimeEditor nowMs={new Date(2026, 8, 9).getTime()}
                value={value} onChange={setValue}
                labels={{ date: 'Date', time: 'Time', pastInstant: 'Past' }} testIDPrefix="editor" />;
        }
        const screen = await renderScreen(<Harness />);
        // Each picker is a named button (the shared field's own pressable, by role).
        const buttonRole = (testID: string) => screen.findAll((node) => node.props.testID === testID)
            .map((node) => node.props.accessibilityRole ?? node.props.role).find(Boolean);
        expect(buttonRole('editor-date-picker-button')).toBe('button');
        expect(buttonRole('editor-time-picker-button')).toBe('button');
        await act(async () => screen.changeTextByTestId('editor-date-input', '2026-09-11'));
        await act(async () => screen.changeTextByTestId('editor-time-input', '14:25'));
        expect(screen.findByTestId('editor-date-input')?.props.value).toBe('2026-09-11');
        expect(screen.findByTestId('editor-time-input')?.props.value).toBe('14:25');
    });
});
