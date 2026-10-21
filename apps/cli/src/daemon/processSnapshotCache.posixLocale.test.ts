import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.fn();

vi.mock('ps-list', () => ({
  default: (...args: unknown[]) => psListMock(...args),
}));

describe('process snapshot posix locale', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalLang = process.env.LANG;
  const originalLcAll = process.env.LC_ALL;

  beforeEach(() => {
    vi.resetModules();
    psListMock.mockReset();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'darwin' });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (originalLang === undefined) delete process.env.LANG;
    else process.env.LANG = originalLang;
    if (originalLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLcAll;
  });

  // @happier-platform:begin feat=daemon-ps-locale-fix RED/GREEN 用例（ps-list 通路）
  it('runs the ps-list scan with a forced UTF-8 locale and restores an unset ambient environment', async () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    const observed: Array<{ lang: string | undefined; lcAll: string | undefined }> = [];
    psListMock.mockImplementation(async () => {
      observed.push({ lang: process.env.LANG, lcAll: process.env.LC_ALL });
      return [];
    });

    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await listProcessSnapshot({ ttlMs: 0 });

    // The daemon may run under launchd without LANG/LC_*; the ps-list child must never
    // see that C locale (BSD ps M-escapes non-ASCII bytes in captured command lines).
    expect(observed).toEqual([{ lang: 'en_US.UTF-8', lcAll: 'en_US.UTF-8' }]);
    expect(process.env.LANG).toBeUndefined();
    expect(process.env.LC_ALL).toBeUndefined();
  });

  it('restores a pre-existing ambient locale after the scan', async () => {
    process.env.LANG = 'xx_XX.ISO8859-1';
    delete process.env.LC_ALL;
    psListMock.mockImplementation(async () => []);

    const { listProcessSnapshot } = await import('./processSnapshotCache');
    await listProcessSnapshot({ ttlMs: 0 });

    expect(process.env.LANG).toBe('xx_XX.ISO8859-1');
    expect(process.env.LC_ALL).toBeUndefined();
  });
  // @happier-platform:end feat=daemon-ps-locale-fix
});
