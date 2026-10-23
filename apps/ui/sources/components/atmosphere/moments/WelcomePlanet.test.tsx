import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { HomePlanet, homePlanetFootFade, useHomePlanetOptions, type HomePlanetLook } from '../HomePlanet';
import { PlanetCanvas } from '../PlanetCanvas';
import { PlanetMomentCanvas } from './PlanetMomentCanvas';
import { WelcomePlanet } from './WelcomePlanet';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const look: HomePlanetLook = {
  pane: { width: 280, height: 240 }, placement: 'rise', style: 'balanced', digits: true,
  theme: 'dark', phone: false, hero: { composerTop: 40, aboveBottom: 70, nextTop: 220 },
};

function Scene(props: Readonly<{ visible?: boolean; writing?: boolean; reducedMotion?: boolean; onLanded: () => void }>) {
  const options = useHomePlanetOptions(look)!;
  return <>
    <WelcomePlanet pane={look.pane} options={options} fade={homePlanetFootFade(look)} visible={props.visible ?? true}
      writing={props.writing ?? false} reducedMotion={props.reducedMotion ?? false} onLanded={props.onLanded} />
    <HomePlanet {...look} hidden leave="fade" reducedMotion={false} />
  </>;
}

async function frames(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await act(async () => { vi.advanceTimersByTime(16); });
  }
}

describe('Welcome landing and live motion inputs', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }); });
  afterEach(() => { vi.useRealTimers(); });

  it('withdraws every Welcome canvas while retained and resumes the same assembly clock', async () => {
    const onLanded = vi.fn();
    const scene = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>
      <Scene onLanded={onLanded} />
    </PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(scene(true));
    try {
      await frames(320);
      const before = screen.findByType(PlanetMomentCanvas).props.frame.t;
      await screen.update(scene(false));
      expect(screen.findAllHostsByTestId('welcome-planet.assembly')).toHaveLength(0);
      expect(screen.findAllHostsByTestId('welcome-planet.rest')).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      await frames(2400);
      expect(onLanded).not.toHaveBeenCalled();
      await screen.update(scene(true));
      expect(screen.findByType(PlanetMomentCanvas).props.frame.t).toBe(before);
      await frames(1800);
      expect(onLanded).toHaveBeenCalledOnce();
    } finally { await screen.unmount(); }
  });

  it('does not prepare the assembly in an inactive Home pane', async () => {
    const onLanded = vi.fn();
    const screen = await renderScreen(<Scene visible={false} onLanded={onLanded} />);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(vi.getTimerCount()).toBe(0);
    await screen.update(<Scene onLanded={onLanded} />);
    expect(vi.getTimerCount()).toBe(1);
    await frames(2100);
    expect(onLanded).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds its finite clock while Home is unfocused or the person writes, then resumes', async () => {
    const onLanded = vi.fn();
    const screen = await renderScreen(<Scene onLanded={onLanded} />);
    await frames(320);
    const before = screen.findByType(PlanetMomentCanvas).props.frame.t;
    await screen.update(<Scene visible={false} onLanded={onLanded} />);
    await frames(2400);
    expect(screen.findByTestId('welcome-planet.assembly') !== null).toBe(true);
    expect(screen.findByType(PlanetMomentCanvas).props.frame.t).toBe(before);
    expect(onLanded).not.toHaveBeenCalled();
    await screen.update(<Scene writing onLanded={onLanded} />);
    await frames(2400);
    expect(screen.findByTestId('welcome-planet.assembly') !== null).toBe(true);
    expect(screen.findByType(PlanetMomentCanvas).props.frame.t).toBe(before);
    expect(onLanded).not.toHaveBeenCalled();
    await screen.update(<Scene onLanded={onLanded} />);
    expect(vi.getTimerCount()).toBe(1);
    await frames(1800);
    expect(onLanded).toHaveBeenCalledOnce();
    expect(screen.findByTestId('welcome-planet') === null).toBe(true);
  });

  it('settles immediately if reduced motion changes during the assembly', async () => {
    const onLanded = vi.fn();
    const screen = await renderScreen(<Scene onLanded={onLanded} />);
    await frames(320);
    await screen.update(<Scene reducedMotion onLanded={onLanded} />);
    expect(screen.findByTestId('welcome-planet') === null).toBe(true);
    expect(onLanded).toHaveBeenCalledOnce();
    await frames(2400);
    expect(onLanded).toHaveBeenCalledOnce();
  });

  it('lands on exactly the same Rise scene and ordered foot window as Home', async () => {
    const screen = await renderScreen(<Scene onLanded={() => {}} />);
    await frames(1856);
    const canvases = screen.findAllByType(PlanetCanvas);
    const welcome = canvases.find(canvas => canvas.props.testID === 'welcome-planet.rest')!;
    const home = canvases.find(canvas => canvas.props.testID === 'home-planet')!;
    expect(welcome.props.options).toEqual(home.props.options);
    expect(home.props.fade).toBeDefined();
    expect(welcome.props.fade).toEqual(home.props.fade);
  });
});
