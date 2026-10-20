/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// The marker must survive the real RNW prop filter to reach forced-colors CSS.
vi.mock('react-native', async () => vi.importActual('react-native-web'));

// Keep the real settings hook/store; vitestSetup owns the in-memory persistence boundaries.
const { TextInput } = await import('./Text');

it('marks real single-line and multiline inputs for the shared forced-colors focus rule', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<>
            <TextInput testID="core-field" accessibilityLabel="Name" value="Draft" onChangeText={() => {}} />
            <TextInput testID="core-multiline" accessibilityLabel="Notes" value="Notes" multiline onChangeText={() => {}} />
        </>));
        for (const testId of ['core-field', 'core-multiline']) {
            const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
            expect(input).not.toBeNull();
            expect(input!.getAttribute('data-happier-text-input')).toBe('true');
            expect(getComputedStyle(input!).outlineWidth).toBe('0px');
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
