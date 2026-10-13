import { describe, expect, it, vi } from 'vitest';
import { resolveCanonicalMachineId } from '@happier-dev/protocol';
const transport = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: { get: transport.get } }));
import { fetchAccountMachineReplacements } from './fetchAccountMachineReplacements';

describe('retained Machine replacement identity', () => {
  it('preserves a revoked predecessor for the real canonical replacement walk', async () => {
    transport.get.mockImplementation(async (url: string) => ({ data: new URL(url).searchParams.get('includeRevoked') === 'true'
      ? [{ id: 'old', replacedByMachineId: 'current', revokedAt: 1 }, { id: 'current' }]
      : [{ id: 'current' }] }));
    const records = await fetchAccountMachineReplacements({ credentials: { token: 'fixture-token' } });
    expect(resolveCanonicalMachineId('old', records ?? [])?.machineId).toBe('current');
  });
});
