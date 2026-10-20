import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

import { ExchangeCheckInBannerView } from './ExchangeCheckInBanner';

afterEach(() => standardCleanup());

describe('ExchangeCheckInBannerView', () => {
    it('sends each exchange control from its own button and says how many times agents asked', async () => {
        const onControl = vi.fn();
        const screen = await renderScreen(<ExchangeCheckInBannerView testID="check-in" count={5} body="Next" onControl={onControl} />);
        expect(screen.getTextContent()).toContain('Agents asked each other 5 times');
        for (const id of ['check-in.stop', 'check-in.continue_more', 'check-in.continue']) {
            invokeTestInstanceHandler(screen.findByTestId(id), 'onPress');
        }
        expect(onControl.mock.calls.map(([control]) => control)).toEqual(['stop', 'continue_more_10', 'continue']);
    });

    it('holds every control while one decision is in flight', async () => {
        const screen = await renderScreen(<ExchangeCheckInBannerView testID="check-in" count={2} body="Next" pending="continue" onControl={() => {}} />);
        for (const id of ['check-in.stop', 'check-in.continue_more', 'check-in.continue']) {
            expect(screen.findByTestId(id)?.props.disabled).toBe(true);
        }
    });
});
