import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// MMKV is a native/browser persistence boundary; embed storage must never open it.
vi.mock('react-native-mmkv', () => ({ MMKV: class { constructor() { throw new Error('durable storage opened'); } } }));

// The shared per-test setup loads the Machine reachability graph, which evaluates the immutable embed
// context. Drop it so each test's window stub is what the realm boots from.
beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('embed storage isolation', () => {
    it('keeps local settings, drafts and large records in the frame without opening durable storage', async () => {
        vi.stubGlobal('window', {
            location: { pathname: '/embed/session/one' },
            get localStorage() { throw new Error('localStorage opened'); },
            addEventListener() { throw new Error('cross-tab observer installed'); },
        });
        vi.stubGlobal('document', {});
        vi.stubGlobal('indexedDB', { open() { throw new Error('IndexedDB opened'); } });
        vi.stubGlobal('navigator', { get locks() { throw new Error('cross-tab locks opened'); } });
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const storage = getPersistenceStorage();
        expect(storage.getString('app-settings')).toBeUndefined();
        storage.set('draft', 'retained in this frame');
        expect(storage.getString('draft')).toBe('retained in this frame');
        storage.delete('draft');
        expect(storage.getString('draft')).toBeUndefined();
        const { getSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        const drafts = getSessionDraftPersistenceStorage();
        drafts.set('session-draft', 'draft without a storage bootstrap');
        expect(drafts.getString('session-draft')).toBe('draft without a storage bootstrap');
        const deviceStorage = await import('@/auth/storage/deviceLocalStorage');
        expect(await deviceStorage.readDeviceLocalStorageString('saved-account-credential')).toBeNull();
        await deviceStorage.writeDeviceLocalStorageString('ephemeral', 'frame-only');
        expect(await deviceStorage.readDeviceLocalStorageString('ephemeral')).toBe('frame-only');
        await deviceStorage.removeDeviceLocalStorageString('ephemeral');
        expect(await deviceStorage.readDeviceLocalStorageString('ephemeral')).toBeNull();
        const profiles = await import('@/sync/domains/server/serverProfiles');
        expect(profiles.listServerProfiles()).toBeInstanceOf(Array);
        const unsubscribe = profiles.subscribeServerProfiles(() => {});
        unsubscribe();
        const { withHomeMutationAuthority } = await import('@/sync/domains/server/homeMutationLock');
        expect(await withHomeMutationAuthority(undefined, () => 'frame-only')).toBe('frame-only');
        const records = await import('@/sync/domains/state/browserRecordStorage');
        await records.writeBrowserRecord('draft', 'one');
        await records.updateBrowserRecord('draft', (current) => ({ value: `${current}:two`, result: undefined }));
        expect(await records.readBrowserRecord('draft')).toBe('one:two');
        await expect(records.updateBrowserRecord('draft', () => { throw new Error('encode failed'); })).rejects.toThrow('encode failed');
        expect(await records.listBrowserRecords('draft')).toEqual(new Map([['draft', 'one:two']]));
        await records.clearBrowserRecords();
        expect(await records.readBrowserRecord('draft')).toBeUndefined();
    });

    it('pins the embed context for the realm even after a route changes', async () => {
        const location = { pathname: '/embed/new' };
        vi.stubGlobal('window', { location });
        const { isEmbedWindowContext } = await import('./isEmbedWindowContext');
        expect(isEmbedWindowContext()).toBe(true);
        location.pathname = '/settings';
        expect(isEmbedWindowContext()).toBe(true);
    });

    it('retires only frame-local records and drafts without reopening durable storage', async () => {
        vi.stubGlobal('window', { location: { pathname: '/embed/session/one' } });
        vi.stubGlobal('indexedDB', { open() { throw new Error('IndexedDB opened'); } });
        const { getPersistenceStorage, clearEmbedMemoryStorage } = await import('@/sync/domains/state/persistenceStorage');
        const records = await import('@/sync/domains/state/browserRecordStorage');
        clearEmbedMemoryStorage();
        records.clearEmbedBrowserRecords();
        const storage = getPersistenceStorage();
        storage.set('session-draft', 'private draft');
        await records.writeBrowserRecord('outbox', 'private message');
        clearEmbedMemoryStorage();
        records.clearEmbedBrowserRecords();
        expect(storage.getString('session-draft')).toBeUndefined();
        expect(await records.readBrowserRecord('outbox')).toBeUndefined();
    });

    it('does not open or purge full-app durable adapters when embed retirement is called', async () => {
        vi.stubGlobal('window', { location: { pathname: '/session/one' } });
        vi.stubGlobal('indexedDB', { open() { throw new Error('IndexedDB opened'); } });
        const { clearEmbedMemoryStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { clearEmbedBrowserRecords } = await import('@/sync/domains/state/browserRecordStorage');
        expect(() => clearEmbedMemoryStorage()).not.toThrow();
        expect(() => clearEmbedBrowserRecords()).not.toThrow();
    });

    it('does not turn an already running app realm into an embed on navigation', async () => {
        const location = { pathname: '/session/one' };
        vi.stubGlobal('window', { location });
        const { isEmbedWindowContext } = await import('./isEmbedWindowContext');
        expect(isEmbedWindowContext()).toBe(false);
        location.pathname = '/embed/new';
        expect(isEmbedWindowContext()).toBe(false);
    });
});
