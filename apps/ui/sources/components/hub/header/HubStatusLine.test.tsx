import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { HubStatusLineView } from './HubStatusLine';

afterEach(standardCleanup);

describe('Home status observation', () => {
    it('keeps the Home identity without claiming idle until sessions are known', async () => {
        const home = () => <>{'Home A'}</>;
        const screen = await renderScreen(<HubStatusLineView working={0} needsYou={0} isDataReady={false} home={home} />);
        expect(screen.getTextContent()).toContain('Home A');
        expect(screen.getTextContent()).not.toContain('Nothing running');
        await screen.update(<HubStatusLineView working={0} needsYou={0} isDataReady={true} home={home} />);
        expect(screen.getTextContent()).toContain('Nothing running');
    });
});
