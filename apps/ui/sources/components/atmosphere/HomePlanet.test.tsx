import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { HomePlanet } from './HomePlanet';
import { PlanetCanvas } from './PlanetCanvas';
import { useHomeWelcome, type HomeWelcome } from './moments/useHomeWelcome';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const pane = { width: 280, height: 240 };

describe('Rise foot fade', () => {
  it('draws the planet down to the end of its ordered foot fade when the hero runs past the first fold', async () => {
    const desk = { width: 990, height: 850 };
    // Two rows of suggestions and the 200 px Rise foot put the widgets' header below the fold.
    const hero = { composerTop: 330, aboveBottom: 560, nextTop: 1010 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        placement="rise"
        style="balanced"
        digits
        theme="light"
        phone={false}
        hero={hero}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(PlanetCanvas);
    const fade = canvas.props.fade as { from: number; to: number };
    expect(fade.to).toBeGreaterThan(desk.height);
    expect(canvas.props.height).toBeGreaterThanOrEqual(fade.to);
    expect(canvas.props.options.view.h).toBe(canvas.props.height);
  });

  it('keeps Corner to the pane', async () => {
    const desk = { width: 990, height: 850 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        placement="corner"
        style="balanced"
        digits
        theme="light"
        phone={false}
        hero={{ composerTop: 330, aboveBottom: 560, nextTop: 1010 }}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(PlanetCanvas);
    expect(canvas.props.height).toBe(desk.height);
    expect(canvas.props.options.view.h).toBe(desk.height);
  });
});

describe('Welcome retype subscription locality', () => {
  let previous: ReturnType<typeof storage.getState>;
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    previous = storage.getState();
    storage.setState((state) => ({
      ...state,
      localSettings: { ...localSettingsDefaults, homeWelcomeSeenAt: null },
    }));
  });
  afterEach(async () => {
    await act(async () => {
      storage.setState(previous, true);
    });
    vi.useRealTimers();
  });

  it('ticks only the planet, holds while writing or unfocused, and ends after leaving Home', async () => {
    let homeRenders = 0;
    let unrelatedRenders = 0;
    let welcome: HomeWelcome;
    function Content() {
      unrelatedRenders += 1;
      return null;
    }
    function Home(
      props: Readonly<{
        eligible?: boolean;
        writing?: boolean;
        reducedMotion?: boolean;
      }>,
    ) {
      homeRenders += 1;
      welcome = useHomeWelcome({
        eligible: props.eligible ?? true,
        loadingShown: false,
        reducedMotion: props.reducedMotion ?? false,
        writing: props.writing ?? false,
      });
      return (
        <>
          <Content />
          <HomePlanet
            pane={pane}
            placement="corner"
            style="balanced"
            digits
            theme="dark"
            phone={false}
            hero={null}
            hidden={welcome.playing}
            leave="fade"
            reducedMotion={props.reducedMotion ?? false}
            focused={props.eligible ?? true}
            writing={props.writing ?? false}
            retype={welcome.retype}
          />
        </>
      );
    }
    const screen = await renderScreen(<Home />);
    await act(async () => {
      welcome!.onLanded();
    });
    const initialHomeRenders = homeRenders;
    const initialContentRenders = unrelatedRenders;
    const time = () => screen.findByType(PlanetCanvas).props.options.time;
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(time()).toBe(2);
    expect(homeRenders).toBe(initialHomeRenders);
    expect(unrelatedRenders).toBe(initialContentRenders);
    await screen.update(<Home writing />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(time()).toBe(2);
    await screen.update(<Home />);
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(time()).toBe(2.5);
    await screen.update(<Home eligible={false} />);
    const atBlur = time();
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(time()).toBe(atBlur);
    await screen.update(<Home />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(time()).toBe(atBlur);
  });
});
