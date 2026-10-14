import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const boundary = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
// The mounted Action and modal/navigation hosts are boundaries. Detail, status and editors stay real.
vi.mock('@/components/approvals/useMountedActionExecution', () => ({ useMountedActionExecution: () => ({ execute: boundary.execute, ready: true, isCurrent: () => true, approval: {} }) }));
const { Modal } = await import('@/modal');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { McpServerDetailPage } = await import('./McpServerDetailPage');
const { ValueRefEditorModal } = await import('@/components/ui/forms/valueRefs/ValueRefEditorModal');
const { McpSignInSection } = await import('../signIn/McpSignInSection');

const base = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', headers: {} } });
const unavailable = { resolveReference: (ref: string) => resolveSavedSecretReference(null, [], ref) };

async function page(server = base) {
  let draft = server;
  const commit = vi.fn();
  const tree = await renderScreen(<McpServerDetailPage server={server} draftServer={draft} catalogRevision={null} secrets={[]} secretAvailability={unavailable}
    scope={null} configurationSaveState="idle" onCommitConfiguration={commit} onRemove={() => {}} approvalNotice={null}
    onChangeServer={updater => { draft = updater(draft); }} />);
  return { tree, commit, draft: () => draft };
}
beforeEach(() => {
  boundary.execute.mockReset();
  vi.mocked(Modal.show).mockClear();
  getStorage().setState({ settingsScope: null });
});
afterEach(standardCleanup);

describe('saved MCP detail recovery wiring', () => {
  it('the real missing-key banner opens the ValueRef editor and saves the repaired reference', async () => {
    const server = McpServerCatalogEntryV1Schema.parse({ ...base, env: { TOKEN: { t: 'savedSecret', secretId: 'missing' } } });
    const current = await page(server);
    await current.tree.pressByTestIdAsync('mcp.server.banner.action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.initialKey).toBe('TOKEN');
    expect(props.onSubmit({ key: 'TOKEN', valueRef: { t: 'savedSecret', secretId: 'replacement' } })).toBe(true);
    expect(current.draft().env.TOKEN).toEqual({ t: 'savedSecret', secretId: 'replacement' });
    expect(current.commit).toHaveBeenCalled();
  });

  it('client refusal keeps the API-key alternative and saves through the existing header editor', async () => {
    const current = await page(McpServerCatalogEntryV1Schema.parse({ ...base, remote: { ...base.remote, auth: { kind: 'oauth' } } }));
    boundary.execute.mockResolvedValue({ ok: false, errorCode: 'client_refused', error: 'client_refused' });
    await act(async () => { await current.tree.findByType(McpSignInSection).props.signIn.start(); });
    await current.tree.pressByTestIdAsync('mcp.server.signin:client-refused:action');
    expect(Modal.show).toHaveBeenCalled();
    const opened = vi.mocked(Modal.show).mock.calls.at(-1)![0];
    expect(opened.component).toBe(ValueRefEditorModal);
    const props = opened.props as React.ComponentProps<typeof ValueRefEditorModal>;
    expect(props.kind).toBe('header');
    expect(props.onSubmit({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'api-key' } })).toBe(true);
    expect(current.draft().remote).toEqual({ url: base.remote!.url, headers: { Authorization: { t: 'template', template: 'Bearer {api_key}', vars: { api_key: { t: 'savedSecret', secretId: 'api-key' } } } } });
    expect(current.commit).toHaveBeenCalled();
  });
});
