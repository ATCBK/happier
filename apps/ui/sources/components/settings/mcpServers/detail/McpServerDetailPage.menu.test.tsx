import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const boundary = vi.hoisted(() => ({ execute: vi.fn(), copy: vi.fn(async (_value: string) => true) }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The mounted Action host and the platform clipboard are the boundaries; header, menu and read parsing stay real.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({ useMountedActionExecution: () => ({ execute: boundary.execute, ready: true, isCurrent: () => true, approval: {} }) }));
vi.mock('@/utils/ui/clipboard', () => ({ setClipboardStringSafe: boundary.copy }));
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpServerDetailPage } = await import('./McpServerDetailPage');
const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');

const server = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {} } });
const availability = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };
const LINK = 'https://app.example.test/settings/mcp?install=abc';

function readResult(installLink?: string) {
  return { ok: true, result: { status: 'present', server, bindings: [], revision: 3, authority: 'active', complete: true,
    diagnostics: [], ...(installLink ? { installLink } : {}) } };
}
async function page(onDuplicate = vi.fn()) {
  const tree = await renderScreen(<McpServerDetailPage server={server} draftServer={server} catalogRevision={3} secrets={[]}
    secretAvailability={availability} scope={null} configurationSaveState="idle" onCommitConfiguration={() => {}}
    onRemove={() => {}} onDuplicate={onDuplicate} approvalNotice={null} onChangeServer={() => {}} />);
  return { tree, onDuplicate, actions: () => tree.findByType(PageHeaderMenu).props.actions as readonly { id: string; onSelect: () => unknown }[] };
}
beforeEach(() => {
  boundary.execute.mockReset();
  boundary.copy.mockClear();
  boundary.copy.mockResolvedValue(true);
  retirePresentationNotice();
  getStorage().setState({ settingsScope: null });
});
afterEach(standardCleanup);

describe('saved MCP server header menu', () => {
  it('offers Duplicate, and Copy install link when the server read carries one, which copies exactly that link', async () => {
    boundary.execute.mockImplementation(async (actionId: string) => actionId === 'mcp.servers.read' ? readResult(LINK) : { ok: false, errorCode: 'x', error: 'x' });
    const current = await page();
    await vi.waitFor(() => expect(current.actions().map((action) => action.id)).toEqual(['duplicate', 'copyInstallLink']));
    expect(boundary.execute).toHaveBeenCalledWith('mcp.servers.read', { serverId: 'linear' });
    await current.actions()[1]!.onSelect();
    expect(boundary.copy).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(readPresentationNotice()).toMatchObject({ severity: 'info' });
    // A repeat copy replaces the notice rather than stacking another.
    const key = readPresentationNotice()!.key;
    await current.actions()[1]!.onSelect();
    expect(readPresentationNotice()!.key).toBe(key);
    await current.actions()[0]!.onSelect();
    expect(current.onDuplicate).toHaveBeenCalledOnce();
  });

  it('hides Copy install link when the read has no link', async () => {
    boundary.execute.mockImplementation(async () => readResult());
    const current = await page();
    await vi.waitFor(() => expect(boundary.execute).toHaveBeenCalled());
    expect(current.actions().map((action) => action.id)).toEqual(['duplicate']);
  });

  it('says so when the clipboard refuses the link', async () => {
    boundary.execute.mockImplementation(async () => readResult(LINK));
    boundary.copy.mockResolvedValue(false);
    const current = await page();
    await vi.waitFor(() => expect(current.actions()).toHaveLength(2));
    await current.actions()[1]!.onSelect();
    expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
  });
});
