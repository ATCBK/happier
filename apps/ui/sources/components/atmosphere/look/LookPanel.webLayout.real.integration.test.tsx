// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  installWebLayoutBridge,
  measureWebLayout,
} from '@/dev/testkit/render/measureWebLayout';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

// Real react-native-web layout in a real Chromium. `HAPPIER_WEB_LAYOUT_SHOTS=<dir>` also saves each
// settled frame; `HAPPIER_WEB_LAYOUT_THEME=dark` draws them on the dark theme.
const shots = process.env.HAPPIER_WEB_LAYOUT_SHOTS;
const themeName =
  process.env.HAPPIER_WEB_LAYOUT_THEME === 'dark' ? 'dark' : 'light';
installSettingsViewCommonModuleMocks({
  reactNative: async () => vi.importActual('react-native-web'),
  storage: 'real',
  text: async () => vi.importActual('@/text'),
  unistyles: async () => {
    const { createUnistylesMock } =
      await import('@/dev/testkit/mocks/unistyles');
    const { darkTheme } = await import('@/theme');
    return createUnistylesMock(
      themeName === 'dark'
        ? {
            theme: darkTheme as never,
            rt: { themeName: 'dark', colorScheme: 'dark' },
          }
        : undefined,
    );
  },
});
vi.mock('react-native-reanimated', async () => {
  const { createReanimatedModuleMock } =
    await import('@/dev/testkit/mocks/reanimated');
  const native = await import('react-native');
  const mock = createReanimatedModuleMock();
  const Animated = {
    ...mock.default,
    View: native.View,
    ScrollView: native.ScrollView,
    Text: native.Text,
  };
  return { ...mock, ...Animated, default: Animated };
});
// The device picture store's storage boundary: the browser store over fake IndexedDB.
vi.mock(
  '@/components/atmosphere/pictureStore',
  async () => import('@/components/atmosphere/pictureStore.web'),
);

const { ATMOSPHERE_PICTURES } = await import('@happier-dev/brand/atmosphere');
const { DEFAULT_HOME_ATMOSPHERE } =
  await import('@happier-dev/protocol/account/settings/accountSettings');
const { LookPanel } = await import('./LookPanel');
const { PictureControls, PlanetControls, SourceControl } =
  await import('./LookControls');
const { View } = await import('react-native');
const { darkTheme, lightTheme } = await import('@/theme');
// The frame stands on the page colour of the theme it is drawn in.
const ground = (themeName === 'dark' ? darkTheme : lightTheme).colors.surface.base;
type ProjectAtmosphere =
  import('@happier-dev/protocol/account/settings/accountSettings').ProjectAtmosphere;
type AtmosphereEditor = import('./atmosphereEditor').AtmosphereEditor;

const { moments: _moments, ...HOME } = DEFAULT_HOME_ATMOSPHERE;
const PICTURE: ProjectAtmosphere = {
  ...HOME,
  source: 'picture',
  picture: { ref: { kind: 'builtin', id: 'calm-sea' }, layout: 'wallpaper' },
};

function Editor(
  props: Readonly<{
    initial: ProjectAtmosphere;
    project?: boolean;
    children: (editor: AtmosphereEditor) => React.ReactNode;
  }>,
) {
  const [value, setValue] = React.useState(props.initial);
  const editor = React.useMemo<AtmosphereEditor>(
    () => ({
      value,
      update: (edit) => setValue((current) => ({ ...current, ...edit(current) })),
      ...(props.project
        ? { sameAsHome: true, resetToHome: () => undefined }
        : {}),
    }),
    [props.project, value],
  );
  return <>{props.children(editor)}</>;
}

async function settle(node: React.ReactNode, width: number, name: string, texts: readonly string[] = []) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  const measured = await measureWebLayout(host, {
    viewport: { width, height: 1700 },
    settle: (replay) => act(replay),
    texts: ['Backdrop', 'Placement', 'Glass', 'Blur', 'Layout', 'Look', ...texts],
    ...(shots
      ? { screenshotPath: `${shots}/${name}-${themeName}-after.png` }
      : {}),
  });
  return {
    measured,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  installWebLayoutBridge();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 503 })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const panel = (initial: ProjectAtmosphere, project = false) => (
  <View testID="panel" style={{ width: 380, backgroundColor: ground }}>
    <Editor initial={initial} project={project}>
      {(editor) => <LookPanel editor={editor} />}
    </Editor>
  </View>
);

it('draws every Look block with one header and full-width segments of equal width', async () => {
  const { measured, unmount } = await settle(
    panel(HOME, true),
    412,
    'panel-planet',
  );
  try {
    const width = measured.rect('panel').width;
    for (const prefix of [
      'look-source',
      'appearance-material',
      'appearance-blur',
    ]) {
      const segments = [...measured.rects]
        .filter(([id]) => id.startsWith(`${prefix}:`))
        .map(([, boxes]) => boxes[0]!);
      expect(segments.length, prefix).toBeGreaterThan(1);
      const span =
        Math.max(...segments.map((box) => box.right)) -
        Math.min(...segments.map((box) => box.left));
      expect(span, `${prefix} spans the block`).toBeGreaterThan(width - 40);
      for (const box of segments)
        expect(
          Math.abs(box.width - segments[0]!.width),
          prefix,
        ).toBeLessThanOrEqual(1);
    }
    // The block headers share one size: no row-title header parents a smaller one.
    const heights = ['Backdrop', 'Placement', 'Glass', 'Blur'].map(
      (text) => measured.textRects(text)[0]?.height,
    );
    expect(new Set(heights).size).toBe(1);
  } finally {
    await unmount();
  }
});

it('keeps the picture grids to one caption line, so each row stays one height', async () => {
  const { measured, unmount } = await settle(
    panel(PICTURE),
    412,
    'panel-picture',
  );
  try {
    const looks = [...measured.rects]
      .filter(([id]) => id.startsWith('look-effect:'))
      .map(([, boxes]) => boxes[0]!);
    const firstRow = looks.filter(
      (box) => Math.abs(box.top - looks[0]!.top) < 1,
    );
    expect(firstRow.length).toBeGreaterThan(3);
    for (const box of firstRow) expect(box.height).toBe(firstRow[0]!.height);
    expect(measured.textRects('Layout').length).toBeGreaterThan(0);
  } finally {
    await unmount();
  }
});

it('lays out the Settings blocks with a description and Shuffle on the title line', async () => {
  const page = (initial: ProjectAtmosphere) => (
    <View testID="page" style={{ width: 760, backgroundColor: ground }}>
      <Editor initial={initial}>
        {(editor) => (
          <>
            <SourceControl
              editor={editor}
              presentation="page"
              pictures={ATMOSPHERE_PICTURES}
            />
            {editor.value.source === 'planet' ? (
              <PlanetControls editor={editor} presentation="page" />
            ) : (
              <PictureControls
                editor={editor}
                presentation="page"
                pictures={ATMOSPHERE_PICTURES}
              />
            )}
          </>
        )}
      </Editor>
    </View>
  );
  const picture = await settle(page(PICTURE), 792, 'page-picture');
  try {
    const shuffle = picture.measured.rect('look-shuffle');
    const firstThumb = [...picture.measured.rects].find(([id]) =>
      id.startsWith('atmosphere-picture:'),
    )![1][0]!;
    expect(
      shuffle.bottom,
      'Shuffle sits above the thumbnails, on the title line',
    ).toBeLessThan(firstThumb.top);
  } finally {
    await picture.unmount();
  }
  const planet = await settle(page(HOME), 792, 'page-planet');
  await planet.unmount();
});

it('starts the Settings glass line\'s desktop download on the row text\'s edge', async () => {
  const { GlassEffectiveStateLine } = await import('@/components/settings/appearance/GlassAppearanceControls');
  const { ItemList } = await import('@/components/ui/lists/ItemList');
  const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
  const { t } = await import('@/text');
  const states = (['effectiveBrowser', 'effectiveBrowserSolid', 'effectiveBrowserCustom'] as const).map((key) => t(`settingsAppearance.glassControls.${key}`));
  const downloadLabel = t('setupOnboarding.webDesktopOnlyDesktopAppButton');
  const { measured, unmount } = await settle(
    <View testID="glass-line" style={{ width: 760, backgroundColor: ground }}>
      {/* As on Settings → Appearance: a row of the page's section sheet. */}
      <ItemList><ItemGroup title="Glass"><GlassEffectiveStateLine settings={{}} /></ItemGroup></ItemList>
    </View>,
    792,
    'glass-line',
    [...states, downloadLabel],
  );
  try {
    const title = states.map((text) => measured.textRects(text)[0]).find(Boolean);
    const download = measured.textRects(downloadLabel)[0];
    expect(title, 'the browser explanation').toBeDefined();
    expect(download, 'the desktop download').toBeDefined();
    expect(Math.abs(download!.left - title!.left)).toBeLessThanOrEqual(1);
  } finally {
    await unmount();
  }
});
