import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2UpdateRequestSchema, accountSettingsParse, type AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliSettingsDeclarationAction } from './settingsDeclarationAction';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
type UiResetHost = Readonly<{
  settingsDeclarationAction: NonNullable<ActionExecutorDeps['settingsDeclarationAction']>;
  readSettings(): Readonly<Record<string, unknown>>;
}>;
type UiResetHarnessModule = Readonly<{
  createSettingsResetParityHost(params: Readonly<{
    initial: Readonly<Record<string, unknown>>;
    mutationSnapshot: Readonly<Record<string, unknown>>;
  }>): UiResetHost;
}>;
// Runtime import follows the existing cross-Voice convention: UI aliases/globals stay out of CLI compilation.
const uiHarnessPath = new URL('../../../../ui/sources/dev/testkit/harness/settingsResetParityHarness.ts', import.meta.url).href;
const uiHarness: UiResetHarnessModule = await import(uiHarnessPath);

function executor(settingsDeclarationAction: NonNullable<ActionExecutorDeps['settingsDeclarationAction']>) {
  // Unrelated outward ports must stay unused; the public Action admission remains real.
  const unused = async () => { throw new Error('unexpected_unrelated_transport'); };
  return createActionExecutor({ settingsDeclarationAction,
    executionRunStart: unused, executionRunList: unused, executionRunGet: unused,
    detachedExecutionRunSend: unused, executionRunStop: unused, executionRunAction: unused,
    executionRunWait: unused, sessionOpen: unused, sessionFork: unused, sessionRollback: unused,
    sessionSpawnNew: unused, pathsListRecent: unused, machinesList: unused, serversList: unused,
    reviewEnginesList: unused, agentsBackendsList: unused, agentsModelsList: unused,
    sessionSendMessage: unused, sessionModeSet: unused, sessionModesList: unused, sessionList: unused,
    sessionActivityGet: unused, sessionRecentMessagesGet: unused, resetGlobalVoiceAgent: unused,
    daemonMemorySearch: unused, daemonMemoryGetWindow: unused, daemonMemoryEnsureUpToDate: unused,
  });
}

afterEach(() => { vi.restoreAllMocks(); resetInMemoryAccountSettingsContextForTests(); });

describe('public Settings reset parity', () => {
  it('resets the owner-bound Agent mode while preserving concurrent neighboring policy on both hosts', async () => {
    resetInMemoryAccountSettingsContextForTests();
    const baseline = { analyticsOptOut: true, actionsSettingsV1: { v: 1, actions: {
      'prompt_doc.update': { disabledSurfaces: ['agent'], approvalRequiredSurfaces: ['agent'] },
      'prompt_doc.create': { disabledSurfaces: ['mcp'] },
    } } };
    const concurrent = { analyticsOptOut: true, favoriteMachines: ['concurrent'], actionsSettingsV1: { ...baseline.actionsSettingsV1,
      actions: { ...baseline.actionsSettingsV1.actions,
        'prompt_doc.update': { disabledSurfaces: ['agent', 'cli'], approvalRequiredSurfaces: ['agent', 'mcp'] },
      },
    } };
    let content: AccountSettingsStoredContentEnvelope = { t: 'plain', v: baseline };
    let version = 1;
    // HTTP is the persistence boundary. CLI admission, schema validation and CAS retry remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      expect(request.expectedVersion).toBe(version);
      if (version === 1) {
        content = { t: 'plain', v: concurrent };
        version = 2;
        return { status: 200, data: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content } };
      }
      if (!request.content) throw new Error('Expected stored settings');
      content = request.content;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
    const anchor = 'actions.promptDocAgentEdits';
    const confirmation = { authority: 'present_user', presentUserConfirmation: { actionId: 'settings.reset' } } as const;
    const cli = executor(createCliSettingsDeclarationAction({ credentials: { token: 'reset-parity', encryption: null } }));
    const cliResult = await cli.execute('settings.reset', { anchor }, { ...confirmation, surface: 'cli' });
    expect(cliResult).toMatchObject({ ok: true, result: { anchor, value: 'default' } });
    const cliSettings = accountSettingsParse(content.t === 'plain' ? content.v : {});
    expect(cliSettings.actionsSettingsV1.actions['prompt_doc.update'])
      .toMatchObject({ disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['mcp'] });
    expect(cliSettings.actionsSettingsV1.actions['prompt_doc.create'])
      .toEqual(accountSettingsParse(baseline).actionsSettingsV1.actions['prompt_doc.create']);
    expect(cliSettings.favoriteMachines).toEqual(['concurrent']);

    const uiHost = uiHarness.createSettingsResetParityHost({ initial: baseline, mutationSnapshot: concurrent });
    const ui = executor(uiHost.settingsDeclarationAction);
    expect(await ui.execute('settings.reset', { anchor }, { ...confirmation, surface: 'ui' })).toEqual(cliResult);
    const uiSettings = accountSettingsParse(uiHost.readSettings());
    expect(uiSettings.actionsSettingsV1).toEqual(cliSettings.actionsSettingsV1);
    expect(uiSettings.favoriteMachines).toEqual(['concurrent']);
    for (const [owner, surface] of [[cli, 'cli'], [ui, 'ui']] as const) {
      expect(await owner.execute('settings.get', { anchor }, { ...confirmation, surface }))
        .toMatchObject({ ok: true, result: { anchor, value: 'default' } });
      // Scalar inversion shares default admission; an unsupported reset must remain a refusal.
      expect(await owner.execute('settings.reset', { anchor: 'account.analytics' }, { ...confirmation, surface }))
        .toMatchObject({ ok: true, result: { anchor: 'account.analytics', value: true } });
      expect(await owner.execute('settings.reset', { anchor: 'machines.terminal.host' }, { ...confirmation, surface }))
        .toMatchObject({ ok: false, errorCode: 'setting_reset_unsupported' });
    }
    expect(content.t === 'plain' ? accountSettingsParse(content.v).analyticsOptOut : null).toBe(false);
    expect(accountSettingsParse(uiHost.readSettings()).analyticsOptOut).toBe(false);
  });
});
