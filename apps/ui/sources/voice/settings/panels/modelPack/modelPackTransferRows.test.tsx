import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { resolveModelPackTransferRow } = await import('./modelPackTransferRows');
const { t } = await import('@/text');

describe('resolveModelPackTransferRow', () => {
  it('reports a transfer by its downloaded share', () => {
    const row = resolveModelPackTransferRow({
      status: 'downloading', partialBytes: 0,
      progress: { loaded: 4, total: 8, verified: 0, filesDone: 0, filesTotal: 2 },
    });
    expect(row?.detail).toBe('50%');
  });

  it('shows verification once every byte has arrived but files are still being checked', () => {
    const row = resolveModelPackTransferRow({
      status: 'downloading', partialBytes: 0,
      progress: { loaded: 8, total: 8, verified: 2, filesDone: 1, filesTotal: 2 },
    });
    expect(row?.detail).toBe(t('settingsVoice.local.modelPackDownload.verifyingDetail'));
  });
});
