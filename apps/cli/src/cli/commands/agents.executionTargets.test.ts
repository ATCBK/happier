import { describe, expect, it, vi } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { handleAgentsCommand } from './agents';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

describe('local executable Agent status', () => {
  it('lists native executable declarations without the abstract Custom ACP container', async () => {
    const output = captureConsoleLogAndMuteStdout();
    try {
      await handleAgentsCommand(['list', '--json']);
      const result = JSON.parse(output.logs.join('\n').trim());
      expect(result.ok).toBe(true);
      expect(result.data.agents).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'claude' })]));
      expect(result.data.agents).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'custom-acp' })]));
    } finally {
      output.restore();
    }
  });
});
