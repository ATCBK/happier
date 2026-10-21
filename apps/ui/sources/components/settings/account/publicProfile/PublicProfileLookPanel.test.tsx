import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import {
  DEFAULT_HOME_ATMOSPHERE,
  atmospherePresentation,
  type AtmospherePresentation,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { pictureStore } from '@/components/atmosphere/pictureStore';
import { pictureCreditLine } from '@/components/atmosphere/look/pictureCredit';
import { nativePickImages } from '@/utils/files/nativePickImages';
import { t } from '@/text';
import {
  PublicProfileLookPanel,
  usePreparePublicProfileLook,
  type PublicProfileLookPreparation,
} from './PublicProfileLookPanel';

// Browser Look contract: the platform boundary only; the shared Look controls stay real.
vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
// The device's OS picker is the acquisition boundary; Actions and image ingress stay real.
vi.mock('@/utils/files/nativePickImages', () => ({
  nativePickImages: vi.fn(async () => []),
}));
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
installDisconnectedServerSocketBoundary();
// The device picture store's storage boundary: the browser store over fake IndexedDB.
vi.mock(
  '@/components/atmosphere/pictureStore',
  async () => import('@/components/atmosphere/pictureStore.web'),
);

const library = ATMOSPHERE_PICTURES[0]!;
const base = atmospherePresentation(DEFAULT_HOME_ATMOSPHERE);
const withRef = (
  ref: AtmospherePresentation['picture']['ref'],
): AtmospherePresentation => ({
  ...base,
  source: 'picture',
  picture: { ...base.picture, ref },
});

/** The editor's draft owner: a local candidate the panel reports into. */
function Draft(
  props: Readonly<{
    serverId: string;
    initial: AtmospherePresentation;
    seen: AtmospherePresentation[];
  }>,
) {
  const [value, setValue] = React.useState(props.initial);
  return (
    <PublicProfileLookPanel
      serverId={props.serverId}
      value={value}
      onChange={(next) => {
        props.seen.push(next);
        setValue(next);
      }}
      testID="profile-look"
    />
  );
}

const footerText = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
  screen.findByTestId('public-profile-look-footer')
    ? screen.getTextContent()
    : '';

describe('Public profile Look panel', () => {
  beforeEach(() =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    ),
  );
  afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('edits only the profile candidate with Home Look controls and no global glass rows', async () => {
    const account = await createSecretSettingsTestHarness();
    const initialHome = account.persistedSettings.homeAtmosphere;
    const seen: AtmospherePresentation[] = [];
    try {
      const screen = await renderScreen(
        <Draft
          serverId={account.scope.serverId}
          initial={withRef({ kind: 'builtin', id: library.id })}
          seen={seen}
        />,
      );
      expect(screen.findByTestId('look-source:picture')).not.toBeNull();
      expect(screen.findByTestId('look-layout:wallpaper')).not.toBeNull();
      expect(screen.findByTestId('look-strength')).not.toBeNull();
      expect(screen.findByTestId('appearance-material:clear')).toBeNull();
      expect(screen.findByTestId('appearance-blur:strong')).toBeNull();
      expect(screen.findByTestId('look-same-as-home')).toBeNull();
      await screen.pressByTestIdAsync('look-layout:wallpaper');
      expect(seen.at(-1)?.picture.layout).toBe('wallpaper');
      await screen.pressByTestIdAsync('look-source:planet');
      expect(seen.at(-1)?.source).toBe('planet');
      // Successive edits start from the latest candidate, not the first render's value.
      expect(seen.at(-1)?.picture.layout).toBe('wallpaper');
      expect(account.persistedSettings.homeAtmosphere).toEqual(initialHome);
      expect(account.settingsWrites).toEqual([]);
      await screen.unmount();
    } finally {
      await account.dispose();
    }
  });

  it('credits a library picture as the public page will', async () => {
    const account = await createSecretSettingsTestHarness();
    try {
      const screen = await renderScreen(
        <Draft
          serverId={account.scope.serverId}
          initial={withRef({ kind: 'builtin', id: library.id })}
          seen={[]}
        />,
      );
      expect(screen.findByTestId('public-profile-look-footer')).not.toBeNull();
      expect(footerText(screen)).toContain(library.credit.author);
      expect(screen.getTextContent()).not.toContain(
        t('publicIdentity.look.devicePictureDisclosure'),
      );
      await screen.unmount();
    } finally {
      await account.dispose();
    }
  });

  it('discloses that applying uploads a device picture', async () => {
    const account = await createSecretSettingsTestHarness();
    const localId = 'profile-look-device-picture';
    await pictureStore.put({
      localId,
      kind: 'user',
      data: new Blob(['pixels'], { type: 'image/webp' }),
    });
    try {
      const screen = await renderScreen(
        <Draft
          serverId={account.scope.serverId}
          initial={withRef({ kind: 'user', localId })}
          seen={[]}
        />,
      );
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(screen.getTextContent()).toContain(
          t('publicIdentity.look.devicePictureDisclosure'),
        );
      });
      expect(
        screen.findByTestId('public-profile-look-choose-picture'),
      ).toBeNull();
      expect(screen.getTextContent()).not.toContain(pictureCreditLine(library));
      await screen.unmount();
    } finally {
      await pictureStore.remove(localId);
      await account.dispose();
    }
  });

  it('shows a typed recovery for a missing device picture and acquires a replacement into the draft only', async () => {
    const account = await createSecretSettingsTestHarness();
    const initialHome = account.persistedSettings.homeAtmosphere;
    const seen: AtmospherePresentation[] = [];
    vi.mocked(nativePickImages).mockResolvedValueOnce([
      {
        kind: 'web',
        file: new File(['pixels'], 'photo.png', { type: 'image/png' }),
      },
    ]);
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 16,
      height: 8,
      close() {},
    }));
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
        toBlob: (done: (blob: Blob) => void) =>
          done(new Blob(['prepared-profile'], { type: 'image/webp' })),
      }),
    });
    try {
      const screen = await renderScreen(
        <Draft
          serverId={account.scope.serverId}
          initial={withRef({ kind: 'user', localId: 'gone-from-this-device' })}
          seen={seen}
        />,
      );
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(
          screen.findByTestId('public-profile-look-choose-picture'),
        ).not.toBeNull();
      });
      expect(screen.getTextContent()).not.toContain(
        t('publicIdentity.look.devicePictureDisclosure'),
      );
      // Never a silent swap: the candidate still names the missing picture.
      expect(seen).toEqual([]);
      await screen.pressByTestIdAsync('public-profile-look-choose-picture');
      await vi.waitFor(() =>
        expect(seen.at(-1)?.picture.ref.kind).toBe('user'),
      );
      const ref = seen.at(-1)!.picture.ref;
      if (ref.kind !== 'user')
        throw new Error('Expected an acquired device picture');
      expect(ref.localId).not.toBe('gone-from-this-device');
      expect(account.persistedSettings.homeAtmosphere).toEqual(initialHome);
      expect(account.settingsWrites).toEqual([]);
      await screen.unmount();
      await pictureStore.remove(ref.localId);
    } finally {
      await account.dispose();
    }
  });

  it('prepares the reviewed copy through the canonical preparer and reports a missing device picture', async () => {
    const account = await createSecretSettingsTestHarness();
    const results: PublicProfileLookPreparation[] = [];
    let prepare: ReturnType<typeof usePreparePublicProfileLook> | null = null;
    function Probe() {
      prepare = usePreparePublicProfileLook(account.scope.serverId);
      return null;
    }
    try {
      const screen = await renderScreen(<Probe />);
      await act(async () => {
        results.push(
          await prepare!({
            serverId: account.scope.serverId,
            value: { ...base, source: 'none' },
          }),
        );
        results.push(
          await prepare!({
            serverId: account.scope.serverId,
            value: withRef({ kind: 'user', localId: 'missing-here' }),
          }),
        );
        results.push(
          await prepare!({
            serverId: 'another-home',
            value: { ...base, source: 'none' },
          }),
        );
      });
      expect(results).toEqual([
        { status: 'ready', prepared: { source: 'none' } },
        { status: 'unavailable', reason: 'picture_unavailable' },
        { status: 'unavailable', reason: 'account_retired' },
      ]);
      await screen.unmount();
    } finally {
      await account.dispose();
    }
  });
});
