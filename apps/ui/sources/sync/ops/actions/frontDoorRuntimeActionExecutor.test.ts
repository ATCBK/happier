import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ClipboardWriteResultSchema } from '@happier-dev/protocol/actions/clipboardActionFamily';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const clipboard = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>());
// Only the native clipboard and the canonical Home network/credential boundaries are replaced.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard }));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const {
    createFrontDoorActionExecute,
    createFrontDoorRuntimeActionExecutor,
    createFrontDoorUiActionExecutor,
} = await import('./frontDoorRuntimeActionExecutor');

describe('composed UI Action front-door adapters', () => {
    beforeEach(async () => { await homes.reset(); clipboard.mockReset(); });
    afterEach(() => standardCleanup());

    it('executes both adapters through the default clipboard registration and produces the consumer result shape', async () => {
        const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard-front-door.test', accountId: 'alice' });
        const text = '{\n  "diagnosis": "ready 🔐"\n}\n';
        const copied: string[] = [];
        clipboard.mockImplementation(async value => { copied.push(value); return true; });
        const bridge = createFrontDoorRuntimeActionExecutor();
        const runtimeResult = await bridge({ actionId: 'clipboard.write', input: { text }, context: { surface: 'ui', serverId } });
        expect(ClipboardWriteResultSchema.parse(runtimeResult)).toEqual({ status: 'copied' });
        const action = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        const uiResult = await action('clipboard.write', { text: '' });
        expect(ClipboardWriteResultSchema.parse(uiResult)).toEqual({ status: 'copied' });
        expect(copied).toEqual([text, '']);
    });

    it('preserves admission failures and rejects platform failures without executing disabled or cancelled work', async () => {
        const serverId = await homes.addHome({ name: 'Clipboard', serverUrl: 'https://clipboard-front-door.test', accountId: 'alice' });
        const wrongAccount = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'bob' });
        await expect(wrongAccount('clipboard.write', { text: 'wrong account' })).rejects.toMatchObject({ message: 'action_account_scope_changed' });
        expect(clipboard).not.toHaveBeenCalled();
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'clipboard.write': { enabled: false } } }),
        } }, version: 1 } });
        const bridge = createFrontDoorRuntimeActionExecutor();
        const disabled = await bridge({ actionId: 'clipboard.write', input: { text: 'disabled' }, context: {
            surface: 'ui', serverId,
        } });
        expect(ActionExecuteFailureSchema.parse(disabled)).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(clipboard).not.toHaveBeenCalled();

        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {} }, version: 2 } });
        const action = createFrontDoorUiActionExecutor(undefined, { serverId, expectedAccountId: 'alice' });
        const controller = new AbortController();
        controller.abort();
        await expect(action('clipboard.write', { text: 'cancelled' }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(clipboard).not.toHaveBeenCalled();
        clipboard.mockRejectedValueOnce(new Error('Native clipboard unavailable'));
        await expect(action('clipboard.write', { text: 'platform failure' })).rejects.toMatchObject({ message: 'clipboard_unavailable' });
    });

    it('uses canonical settings admission before a host read can join retained Resource output', async () => {
        const serverId = await homes.addHome({ name: 'Host reads', serverUrl: 'https://host-reads-front-door.test', accountId: 'alice' });
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.get': { enabled: false } } }),
        } }, version: 1 } });
        const execute = createFrontDoorActionExecute();
        expect(await execute.prepare('settings.get', { anchor: 'themePreference' }, {
            surface: 'plugin', serverId, actionCaller: { kind: 'plugin', pluginId: 'acme.preview' },
        })).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
    });
});
