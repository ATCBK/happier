import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HomeIdleResettle } from './HomeIdleResettle';
import { atmosphereResettleFact, useAtmosphereResettlePaused } from './atmosphereStage';

afterEach(() => atmosphereResettleFact.setPaused(true));

it('publishes the focused Home posture without an unfocused split Home overriding playback', async () => {
    let paused = true;
    function Probe() { paused = useAtmosphereResettlePaused(); return null; }
    const element = (writing: boolean, focused = true) => <>
        <HomeIdleResettle picture={null} focused={focused} writing={writing} sending={false} />
        <HomeIdleResettle picture={null} focused={false} writing={false} sending={false} />
        <Probe />
    </>;
    const screen = await renderScreen(element(false));
    expect(paused).toBe(false);
    await screen.update(element(true));
    expect(paused).toBe(true);
    await screen.update(element(false));
    expect(paused).toBe(false);
    await screen.update(element(false, false));
    expect(paused).toBe(true);
    await screen.update(element(false));
    expect(paused).toBe(false);
    await screen.update(<Probe />);
    expect(paused).toBe(true);
    await screen.unmount();
});
