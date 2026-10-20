import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { buildFileShareClipboardRequest, resolveFileShareActionScope } from '@/components/workspaces/files/file/fileShareClipboard';

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
// The native clipboard is the effect boundary; Action admission and Account custody remain real.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

describe('UI clipboard Action', () => {
  beforeEach(async () => { await homes.reset(); clipboard.mockReset(); });
  afterEach(() => standardCleanup());

  it('never rebinds an explicitly unavailable file Account to the composer Account', () => {
    const composer = { serverId: 'home-a', accountId: 'alice' };
    const original = { serverId: 'home-b', accountId: 'bob' };
    expect(resolveFileShareActionScope(null, composer)).toBeNull();
    expect(resolveFileShareActionScope(undefined, composer)).toBe(composer);
    expect(resolveFileShareActionScope(original, composer)).toBe(original);
  });

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

  it('copies exact file paths and canonical Session and Project links through the real clipboard Action', async () => {
    const serverId = await homes.addHome({ name: 'Files', serverUrl: 'https://files.test', accountId: 'alice' });
    const { buildWorkspaceFileLink } = await import('@/utils/url/sessionFileDeepLink');
    for (const target of [
      { kind: 'session' as const, sessionId: 'session-a', serverId },
      { kind: 'project' as const, workspaceRefId: 'workspace-a', serverId, machineId: 'machine-a', rootPath: '/repo' },
    ]) {
      const path = 'src/has space.ts';
      const url = buildWorkspaceFileLink({ target, path, anchor: { kind: 'fileLine', startLine: 9 } });
      const source = { relativePath: path, absolutePath: `C:\\Users\\Alice\\repo\\${path}`, link: url };
      for (const { intent, text } of [
        { intent: { kind: 'path' as const }, text: path },
        { intent: { kind: 'path' as const, absolute: true }, text: source.absolutePath },
        { intent: { kind: 'link' as const }, text: url },
      ]) {
        const request = buildFileShareClipboardRequest(source, intent);
        if (!request) throw new Error('Expected a file clipboard request');
        clipboard.mockResolvedValueOnce(true);
        expect(await createDefaultActionExecutor().execute(request.actionId, request.input,
          { surface: 'ui', serverId, expectedAccountId: 'alice' }))
          .toEqual({ ok: true, result: { status: 'copied' } });
        expect(clipboard).toHaveBeenLastCalledWith(text);
      }
      expect(buildFileShareClipboardRequest({ ...source, absolutePath: null }, { kind: 'path', absolute: true })).toBeNull();
      expect(buildFileShareClipboardRequest({ ...source, link: null }, { kind: 'link' })).toBeNull();
    }
  });
});
