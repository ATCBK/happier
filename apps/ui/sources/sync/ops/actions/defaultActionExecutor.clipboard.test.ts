import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
// The native clipboard is the effect boundary; Action admission and Account custody remain real.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI clipboard Action', () => {
  beforeEach(async () => { await homes.reset(); clipboard.mockReset(); });
  afterEach(() => standardCleanup());

  it('preserves exact diagnostic-export text and reports a refused platform copy truthfully', async () => {
    const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard.test', accountId: 'alice' });
    const text = '{\n  "diagnosis": "ready 🔐"\n}\n';
    clipboard.mockResolvedValueOnce(true);
    expect(await createDefaultActionExecutor().execute('clipboard.write', { text }, { surface: 'ui', serverId }))
      .toEqual({ ok: true, result: { status: 'copied' } });
    expect(clipboard).toHaveBeenLastCalledWith(text);
    clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'));
    expect(await createDefaultActionExecutor().execute('clipboard.write', { text }, { surface: 'ui', serverId }))
      .toMatchObject({ ok: false, errorCode: 'clipboard_unavailable' });
  });
});
