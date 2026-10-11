import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { installVoiceSettingsPanelCommonModuleMocks } from '../voiceSettingsPanelTestHelpers';

installVoiceSettingsPanelCommonModuleMocks({
  storage: () => vi.importActual<typeof import('@/sync/domains/state/storage')>('@/sync/domains/state/storage'),
});

const { useRealtimeVoiceCatalog } = await import('./realtimeVoiceCatalogMenu');
afterEach(() => standardCleanup());

describe('the shared realtime voice catalog', () => {
  it('uses a provider-declared static catalog without contacting the catalog transport', async () => {
    const fetchVoiceCatalog = vi.fn(async () => { throw new Error('static catalog must not request transport'); });
    const rows = [{ id: 'static-voice', name: 'Marin' }];
    const params = { client: { fetchVoiceCatalog }, credentialUsable: true, targetKey: 'declared-static-catalog', declaredRows: rows };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(picker.getCurrent().catalog).toEqual({ phase: 'ready', rows });
    await act(async () => picker.getCurrent().requestCatalog());
    expect(fetchVoiceCatalog).not.toHaveBeenCalled();
  });

  it('retains names for a closed picker across remounts without fetching, scoped to its target', async () => {
    // The client is the provider catalog transport boundary; normalization and retention stay real.
    const fetchVoiceCatalog = vi.fn(async () => [{ id: 'voice-catalog-1', name: 'Sage' }]);
    const params = { client: { fetchVoiceCatalog }, credentialUsable: true, targetKey: 'retained-catalog-target' };
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    expect(fetchVoiceCatalog).not.toHaveBeenCalled();
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(picker.getCurrent().catalog.phase).toBe('ready'));
    await picker.unmount();

    const closed = await renderHook((targetKey: string) => useRealtimeVoiceCatalog({ ...params, targetKey }), {
      initialProps: params.targetKey,
    });
    expect(closed.getCurrent().lastKnownRows).toEqual([{ id: 'voice-catalog-1', name: 'Sage', previewUrl: null }]);
    expect(fetchVoiceCatalog).toHaveBeenCalledTimes(1);
    await closed.rerender('different-credential-target');
    expect(closed.getCurrent().lastKnownRows).toBeNull();
    expect(fetchVoiceCatalog).toHaveBeenCalledTimes(1);
  });

  it('updates a closed reader through the same owner and keeps the known name after a failed refresh', async () => {
    const fetchVoiceCatalog = vi.fn(async () => [{ id: 'voice-catalog-2', name: 'Marin' }]);
    const params = { client: { fetchVoiceCatalog }, credentialUsable: true, targetKey: 'shared-catalog-target' };
    const closed = await renderHook(() => useRealtimeVoiceCatalog(params));
    const picker = await renderHook(() => useRealtimeVoiceCatalog(params));
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin'));
    fetchVoiceCatalog.mockRejectedValueOnce(new Error('catalog transport unavailable'));
    await act(async () => picker.getCurrent().requestCatalog());
    await vi.waitFor(() => expect(picker.getCurrent().catalog.phase).toBe('error'));
    expect(closed.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    expect(picker.getCurrent().lastKnownRows?.[0]?.name).toBe('Marin');
    await act(async () => picker.getCurrent().resetCatalog());
    expect(closed.getCurrent().lastKnownRows).toBeNull();
  });
});
