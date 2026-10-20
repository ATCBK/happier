import { memo, useState } from 'react';
import type { Disposable } from '@happier-dev/plugin-sdk';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it } from 'vitest';

import {
  useHappierUiAccessibility,
  useHappierUiInsets,
  useHappierUiLocalization,
  useHappierUiTheme,
} from '../environment/context.js';
import { useLivePluginResource, usePluginResource } from '../hostApi/index.js';
import { mountThroughReactNativeWeb, mountThroughReactNativeWebAsync } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider, usePluginTranslation, useSurfaceContext } from './PluginUiProvider.js';
import { Text } from './Text.js';

describe('PluginUiProvider', () => {
  it('keeps a genuine read outage terminal until explicit Retry after readiness', async () => {
    let outage = true;
    let publish: ((context: SurfaceContext) => void) | undefined;
    let retry: (() => void) | undefined;
    const initial = createSurfaceContext({ machineConnectionPending: false, machineExecutionReady: true });
    const host = createHostApiStub(initial, {
      watchContext: async listener => { publish = listener; return { dispose() {} }; },
      readResource: async () => {
        if (outage) throw Object.assign(new Error('Source transport failed'), { code: 'unavailable' });
        return { contentType: 'text/plain', digest: 'ready', bytes: new TextEncoder().encode('ready') };
      },
    });
    function Probe() {
      const { resource, refresh } = usePluginResource('example-read');
      retry = refresh;
      return <output>{resource.error ? 'error' : resource.value ? 'ready' : resource.pending}</output>;
    }
    const mount = await mountThroughReactNativeWebAsync(<PluginUiProvider hostApi={host} context={initial}><Probe /></PluginUiProvider>);
    const { act } = await import('react');
    await act(async () => { await Promise.resolve(); });
    expect(mount.container.textContent).toBe('error');
    outage = false;
    await act(async () => { publish?.(createSurfaceContext({ machineConnectionPending: false, machineExecutionReady: true })); });
    expect(mount.container.textContent).toBe('error');
    await act(async () => { retry?.(); });
    expect(mount.container.textContent).toBe('ready');
    mount.unmount();
  });

  it('does not let a late withdrawn refusal replace a re-admitted read', async () => {
    let rejectOld: ((error: Error) => void) | undefined;
    let publish: ((context: SurfaceContext) => void) | undefined;
    const initial = createSurfaceContext({ machineConnectionPending: false, machineExecutionReady: true });
    const host = createHostApiStub(initial, {
      watchContext: async listener => { publish = listener; return { dispose() {} }; },
      readResource: () => rejectOld === undefined
        ? new Promise((_resolve, reject) => { rejectOld = reject; })
        : Promise.resolve({ contentType: 'text/plain', digest: 'ready', bytes: new TextEncoder().encode('ready') }),
    });
    function Probe() {
      const { resource } = usePluginResource('example-read');
      return <output>{resource.error ? 'error' : resource.value ? 'ready' : resource.pending}</output>;
    }
    const mount = await mountThroughReactNativeWebAsync(<PluginUiProvider hostApi={host} context={initial}><Probe /></PluginUiProvider>);
    const { act } = await import('react');
    await act(async () => { publish?.(createSurfaceContext({ machineConnectionPending: true, machineExecutionReady: false })); });
    expect(mount.container.textContent).toBe('initial');
    await act(async () => { publish?.(createSurfaceContext({ machineConnectionPending: false, machineExecutionReady: true })); });
    expect(mount.container.textContent).toBe('ready');
    await act(async () => { rejectOld?.(Object.assign(new Error('Withdrawn read'), { code: 'unavailable' })); });
    expect(mount.container.textContent).toBe('ready');
    mount.unmount();
  });

  it('keeps a host-backed read pending during withdrawal and reacquires on re-admission', async () => {
    let pending = true;
    let publish: ((context: SurfaceContext) => void) | undefined;
    const initial = createSurfaceContext({ machineConnectionPending: true, machineExecutionReady: false });
    const host = createHostApiStub(initial, {
      watchContext: async (listener) => { publish = listener; return { dispose() {} }; },
      readResource: async () => {
        if (pending) throw Object.assign(new Error('Host prerequisites are establishing'), { code: 'unavailable' });
        return { contentType: 'text/plain', digest: 'ready', bytes: new TextEncoder().encode('ready') };
      },
    });
    function Probe() {
      const { resource } = usePluginResource('example-read');
      return <output>{resource.error ? 'error' : resource.value ? 'ready' : resource.pending}</output>;
    }
    const mount = await mountThroughReactNativeWebAsync(<PluginUiProvider hostApi={host} context={initial}><Probe /></PluginUiProvider>);
    const { act } = await import('react');
    await act(async () => { await Promise.resolve(); });
    expect(mount.container.textContent).toBe('initial');
    pending = false;
    await act(async () => { publish?.(createSurfaceContext({ machineConnectionPending: false, machineExecutionReady: true })); });
    expect(mount.container.textContent).toBe('ready');
    mount.unmount();
  });

  it('publishes the host projection, never a package-local default', async () => {
    const context = createSurfaceContext({ locale: 'de', contrast: 'high', textScale: 1.25 });
    let observed: SurfaceContext | undefined;

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={createHostApiStub(context)}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(observed?.locale).toBe('de');
    expect(observed?.contrast).toBe('high');
    expect(observed?.textScale).toBe(1.25);
    mount.unmount();
  });

  it('renders nothing rather than fabricating theme facts before the host answers', () => {
    let resolveContext: ((context: SurfaceContext) => void) | undefined;
    const hostApi = createHostApiStub(createSurfaceContext(), {
      context: () => new Promise<SurfaceContext>((resolve) => { resolveContext = resolve; }),
    });

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={hostApi}>
        <Text value="Ready" />
      </PluginUiProvider>,
    );

    expect(mount.container.innerHTML).toBe('');
    expect(resolveContext).toBeTypeOf('function');
    mount.unmount();
  });

  /**
   * §3.10.1 forbids one volatile context carrying theme + insets + accessibility:
   * a safe-area change would rerender every shared component in the tree. This
   * fails against the obvious wrong implementation (a single `useMemo` over the
   * whole environment object).
   */
  it('keeps unchanged theme and localization consumers stable across serialized context pushes', async () => {
    const initial = createSurfaceContext({ translations: { 'acme.ready': 'Ready' } });
    let publish: ((context: SurfaceContext) => void) | undefined;
    const hostApi = createHostApiStub(initial, {
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        publish = listener;
        return { dispose() {} };
      },
    });

    const themeIdentities: unknown[] = [];
    const localizationIdentities: unknown[] = [];
    const translationResolvers: ReturnType<typeof usePluginTranslation>[] = [];
    const accessibilityIdentities: unknown[] = [];
    const insetsIdentities: unknown[] = [];
    let themeRenders = 0;
    const ThemeOnly = memo(function ThemeOnly() {
      themeRenders++;
      return <output data-testid="theme-text">{useHappierUiTheme().colors.text}</output>;
    });

    function Probe() {
      themeIdentities.push(useHappierUiTheme());
      const localization = useHappierUiLocalization();
      localizationIdentities.push(localization);
      translationResolvers.push(localization.translate);
      accessibilityIdentities.push(useHappierUiAccessibility());
      insetsIdentities.push(useHappierUiInsets());
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
        <ThemeOnly />
      </PluginUiProvider>,
    );

    expect(publish).toBeTypeOf('function');
    const initialThemeRenders = themeRenders;
    const { act } = await import('react');
    await act(async () => {
      // Context transports deserialize a fresh message map, even when only
      // another capability changed. Translation-dependent effects must keep
      // their pending work rather than restarting on that transport identity.
      publish?.({ ...initial, theme: structuredClone(initial.theme), translations: { ...initial.translations },
        safeAreaInsets: { top: 44, right: 0, bottom: 34, left: 0 } });
    });

    expect(insetsIdentities.at(-1)).not.toBe(insetsIdentities[0]);
    expect(accessibilityIdentities.at(-1)).toBe(accessibilityIdentities[0]);
    expect(localizationIdentities.at(-1)).toBe(localizationIdentities[0]);
    expect(translationResolvers.at(-1)).toBe(translationResolvers[0]);
    expect(themeIdentities.at(-1)).toBe(themeIdentities[0]);
    expect(themeRenders).toBe(initialThemeRenders);

    await act(async () => {
      publish?.({ ...initial, theme: structuredClone(initial.theme), translations: { ...initial.translations }, contrast: 'high' });
    });

    expect(accessibilityIdentities.at(-1)).not.toBe(accessibilityIdentities[0]);
    expect(localizationIdentities.at(-1)).toBe(localizationIdentities[0]);
    expect(translationResolvers.at(-1)).toBe(translationResolvers[0]);
    expect(themeIdentities.at(-1)).not.toBe(themeIdentities[0]);
    expect(themeRenders).toBe(initialThemeRenders + 1);
    const highContrastTheme = themeIdentities.at(-1);
    const highContrastRenders = themeRenders;
    await act(async () => {
      publish?.({ ...initial, theme: structuredClone(initial.theme), contrast: 'high',
        safeAreaInsets: { top: 48, right: 0, bottom: 34, left: 0 } });
    });
    expect(themeIdentities.at(-1)).toBe(highContrastTheme);
    expect(themeRenders).toBe(highContrastRenders);
    await act(async () => {
      publish?.({ ...initial, translations: { 'acme.ready': 'Bereit' }, locale: 'de' });
    });
    expect(translationResolvers.at(-1)).not.toBe(translationResolvers[0]);
    expect(localizationIdentities.at(-1)).toMatchObject({ locale: 'de' });
    expect(translationResolvers.at(-1)?.('acme.ready')).toBe('Bereit');
    await act(async () => {
      publish?.({ ...initial, theme: { ...structuredClone(initial.theme),
        colors: { ...initial.theme.colors, text: '#123456' } } });
    });
    expect(mount.container.querySelector('[data-testid="theme-text"]')?.textContent).toBe('#123456');
    expect(themeRenders).toBeGreaterThan(highContrastRenders);
    mount.unmount();
  });

  /**
   * The host wrapper ALWAYS supplies `context` so the first paint carries real
   * theme facts (§3.9). Every other reactivity test in this file omits it, so
   * none of them exercises the documented production path: with `context`
   * supplied, a provider that reads the prop instead of the observed snapshot
   * silently drops every `watchContext` push, and a surface keeps rendering the
   * theme, locale and accessibility facts the host held at mount.
   *
   * The prop is the INITIAL snapshot: a newer one from the host is adopted, and
   * neither adoption re-establishes the subscription.
   */
  it('lets watchContext drive after the host supplies the initial context snapshot', async () => {
    const initial = createSurfaceContext({ locale: 'en', textScale: 1 });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let establishCount = 0;
    const hostApi = createHostApiStub(initial, {
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        establishCount += 1;
        publish = listener;
        return { dispose() {} };
      },
    });

    let observed: SurfaceContext | undefined;
    let textScale: number | undefined;
    let accent: string | undefined;
    let pushHostSnapshot: ((context: SurfaceContext) => void) | undefined;

    function Probe() {
      observed = useSurfaceContext();
      textScale = useHappierUiAccessibility().textScale;
      accent = useHappierUiTheme().colors.accent;
      return null;
    }

    function Host() {
      const [context, setContext] = useState<SurfaceContext>(initial);
      pushHostSnapshot = setContext;
      return (
        <PluginUiProvider hostApi={hostApi} context={context}>
          <Probe />
        </PluginUiProvider>
      );
    }

    const mount = await mountThroughReactNativeWebAsync(<Host />);
    expect(observed?.locale).toBe('en');
    expect(establishCount).toBe(1);

    const { act } = await import('react');
    await act(async () => {
      publish?.({
        ...initial,
        locale: 'de',
        textScale: 1.5,
        theme: { ...initial.theme, colors: { ...initial.theme.colors, accent: '#00ff00' } },
      });
    });

    expect(observed?.locale).toBe('de');
    expect(textScale).toBe(1.5);
    expect(accent).toBe('#00ff00');

    // A newer host snapshot delivered through the prop is still adopted, and
    // neither path re-establishes the subscription (§3.6: one establishment per
    // mounted surface).
    await act(async () => {
      pushHostSnapshot?.({ ...initial, locale: 'fr' });
    });
    expect(observed?.locale).toBe('fr');
    expect(establishCount).toBe(1);

    mount.unmount();
  });

  it('retires the context subscription exactly once on unmount', async () => {
    let disposeCount = 0;
    const hostApi = createHostApiStub(createSurfaceContext(), {
      watchContext: async (): Promise<Disposable> => ({
        dispose() { disposeCount += 1; },
      }),
    });

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Text value="Ready" />
      </PluginUiProvider>,
    );
    expect(disposeCount).toBe(0);

    mount.unmount();
    expect(disposeCount).toBe(1);
  });

  it('still establishes watchContext when an initial snapshot read fails', async () => {
    const recovered = createSurfaceContext({ locale: 'de' });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let watchEstablished = false;
    let observed: SurfaceContext | undefined;
    const hostApi = createHostApiStub(recovered, {
      context: async () => {
        throw new Error('initial bridge snapshot unavailable');
      },
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        watchEstablished = true;
        publish = listener;
        return { dispose() {} };
      },
    });

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(watchEstablished).toBe(true);

    const { act } = await import('react');
    await act(async () => {
      publish?.(recovered);
    });
    expect(observed?.locale).toBe('de');
    mount.unmount();
  });

  it('opens a live Resource watch after watchContext recovers from a failed snapshot', async () => {
    const recovered = createSurfaceContext({ locale: 'de' });
    let publish: ((context: SurfaceContext) => void) | undefined;
    let resourceWatchCount = 0;
    let subscription: string | undefined;
    const hostApi = createHostApiStub(recovered, {
      version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: ['watchResource'] }),
      context: async () => {
        throw new Error('initial bridge snapshot unavailable');
      },
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        publish = listener;
        return { dispose() {} };
      },
      watchResource: async (): Promise<Disposable> => {
        resourceWatchCount += 1;
        return { dispose() {} };
      },
    });

    function Probe() {
      subscription = useLivePluginResource('live-status').resource.subscription;
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(resourceWatchCount).toBe(0);

    const { act } = await import('react');
    await act(async () => {
      publish?.(recovered);
      await Promise.resolve();
    });

    expect(resourceWatchCount).toBe(1);
    expect(subscription).toBe('live');
    mount.unmount();
  });

  it('does not let a delayed snapshot replace a newer watched context', async () => {
    const watched = createSurfaceContext({ locale: 'de' });
    const delayedSnapshot = createSurfaceContext({ locale: 'fr' });
    let resolveSnapshot: ((context: SurfaceContext) => void) | undefined;
    let publish: ((context: SurfaceContext) => void) | undefined;
    let watchEstablished = false;
    let observed: SurfaceContext | undefined;
    const hostApi = createHostApiStub(watched, {
      context: () => new Promise<SurfaceContext>((resolve) => { resolveSnapshot = resolve; }),
      watchContext: async (listener: (context: SurfaceContext) => void): Promise<Disposable> => {
        watchEstablished = true;
        publish = listener;
        return { dispose() {} };
      },
    });

    function Probe() {
      observed = useSurfaceContext();
      return null;
    }

    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={hostApi}>
        <Probe />
      </PluginUiProvider>,
    );

    await Promise.resolve();
    expect(watchEstablished).toBe(true);

    const { act } = await import('react');
    await act(async () => {
      publish?.(watched);
    });
    expect(observed?.locale).toBe('de');

    await act(async () => {
      resolveSnapshot?.(delayedSnapshot);
      await Promise.resolve();
    });
    expect(observed?.locale).toBe('de');
    mount.unmount();
  });

  it('resolves translations through one owner shared with the shared presentation layer', async () => {
    const context = createSurfaceContext({ translations: { 'acme.ready': 'Bereit' } });
    let translate: ((
      key: string,
      fallback?: string,
      values?: Readonly<Record<string, string | number>>,
    ) => string) | undefined;

    function Probe() {
      translate = usePluginTranslation();
      return null;
    }

    const mount = await mountThroughReactNativeWebAsync(
      <PluginUiProvider hostApi={createHostApiStub(context)}>
        <Probe />
      </PluginUiProvider>,
    );

    expect(translate?.('acme.ready', 'Ready')).toBe('Bereit');
    expect(translate?.('acme.count', '{count} items', { count: 3 })).toBe('3 items');
    expect(translate?.('acme.absent', 'Ready')).toBe('Ready');
    expect(translate?.('toString', 'Readable fallback')).toBe('Readable fallback');
    mount.unmount();
  });
});
