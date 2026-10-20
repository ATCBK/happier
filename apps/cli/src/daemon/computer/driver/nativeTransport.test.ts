import { describe, expect, it } from 'vitest';
import { native } from './nativeComputerBoundary.testkit';
import { openNativeComputerTransport } from './nativeTransport';

describe('native computer version admission', () => {
  it('accepts the installable descriptor version supplied by the native boundary', async () => {
    const transport = await openNativeComputerTransport('/managed/cua-driver', ':73');
    try { expect(transport.unavailable()).toBe(false); }
    finally { await transport.close(); }
  });

  it('rejects a mismatched version and retires the process before any tools run', async () => {
    native.initialize.mockResolvedValue({ protocolVersion: '2024-11-05', serverInfo: { name: 'cua-driver', version: 'unsupported-version' } });
    await expect(openNativeComputerTransport('/managed/cua-driver', ':73')).rejects.toMatchObject({ code: 'driver_version_mismatch' });
    expect(native.tools).toEqual([]);
    expect(native.instances[0]?.close).toHaveBeenCalledOnce();
  });
});
