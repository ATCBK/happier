import assert from 'node:assert/strict';
import test from 'node:test';
import { collectUiActionParity } from './uiActionParity.ts';

const specs = [
  { id: 'demo.edit', surfaces: { ui: true, agent: true, mcp: true, cli: false } },
  { id: 'settings.set', surfaces: { ui: true, agent: true, mcp: true, cli: true }, cli: { commands: [{ path: ['settings', 'set'] }] } },
];

test('walks aliases, conditional dispatch, registrations and settings instead of a fixed operation inventory', () => {
  const report = collectUiActionParity([{
    filePath: 'apps/ui/sources/components/Example.tsx',
    content: `import { useSettingMutable as usePreference } from '@/sync/domains/state/storage';
      const [value, setValue] = usePreference('density');
      setValue('compact');
      executor.execute(flag ? 'demo.edit' : 'demo.missing', {});
      executor.execute({ actionId: 'demo.missing', input: {} });
      const command = { actionId: 'demo.edit' };
      // executor.execute('comment.ignored', {});
      const label = 'unrelated.label';`,
  }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'demo.edit', 'demo.missing', 'demo.missing', 'demo.edit']);
  assert.deepEqual(report.settings.map(site => site.key), ['density']);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action', 'unregistered_action']);
});

test('rejects hidden agent/MCP and undeclared CLI commands without requiring CLI for client-only Actions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `invoke('demo.edit', {}); execute('demo.cli', {});` }], [
    { ...specs[0], surfaces: { ui: true, agent: false, mcp: false, cli: false } },
    { id: 'demo.cli', surfaces: { ui: true, agent: true, mcp: true, cli: true } },
  ], [], { cliIds: new Set() });
  assert.deepEqual(report.findings.map(finding => finding.code), ['agent_unavailable', 'cli_command_missing']);
});

test('does not count declaration reads as effects; unknown settings and unresolved dynamic ids stay visible', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `getActionSpec('demo.edit'); executor.execute(untypedId, {});
      const [, update] = useLocalSettingMutable('newPreference'); update(true);
      const apply = useApplySettings(); apply({ mystery: true });` }], specs, []);
  assert.equal(report.actions.length, 0);
  assert.deepEqual(report.findings.map(finding => finding.code), [
    'dynamic_action', 'setting_unmapped', 'setting_unmapped',
  ]);
});

test('pre-authentication bootstrap is excluded by its documented surface, not arbitrary Action ids', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/onboarding/preAuth/Example.tsx', content: `executor.execute('bootstrap.signIn', {});` },
    { filePath: 'apps/ui/sources/embed/Example.tsx', content: `executor.execute('composer.attachments.pick', {});` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `executor.execute('composer.attachments.pick', {});` },
  ], specs, []);
  assert.equal(report.actions.length, 1);
  assert.equal(report.exclusions.length, 2);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action']);
});

test('resolves constants in their lexical scope and walks machine dispatch argument positions', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const ACTION_ID = 'demo.edit';
    function first() { executor.execute(ACTION_ID, {}); }
    function second() { const ACTION_ID = 'demo.missing'; executor.execute(ACTION_ID, {}); }
    registry.executeOnMachine(machineId, 'demo.edit', {});
    registerAction({ id: 'demo.edit' });
    const presentationCommand = { id: 'demo.edit', action: () => router.push('/settings') };
    const schema = { actionId: z.string() };
  ` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit', 'demo.missing', 'demo.edit', 'demo.edit']);
  assert.deepEqual(report.findings.map(finding => finding.code), ['unregistered_action']);
});

test('follows the real front-door callable and declared-setting writer rather than their local variable names', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    import { createFrontDoorActionExecute as makeExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
    const perform = makeExecutor(); perform('demo.missing', {});
    const commit = useSettingActionWriter(); commit({ anchor: 'appearance.missing' }, true);
    useAction('demo.missing', {});
  ` }], specs, []);
  assert.deepEqual(report.findings.map(finding => finding.code), [
    'unregistered_action', 'setting_unmapped', 'unregistered_action',
  ]);
});

test('accepts generic CLI invocation when the spec deliberately declares no friendly commands', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `executor.execute('demo.edit', {});` }], [{ ...specs[0],
    surfaces: { ui: true, agent: true, mcp: true, cli: true }, cli: { commands: [] },
  }], [], { cliIds: new Set(['demo.edit']), cliCommandIds: new Set() });
  assert.deepEqual(report.findings, []);
});

test('does not mistake read-only use of a mutable hook for a UI mutation', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `const [value] = useSettingMutable('notWritten');
      const [other, unusedSetter] = useLocalSettingMutable('alsoNotWritten');
      render(value, other);` }], specs, []);
  assert.deepEqual(report.settings, []);
  assert.deepEqual(report.findings, []);
});

test('does not misclassify navigation, RPC transports, read hooks or executor factories as Action invocations', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    navigation.dispatch(route); invoke(target, RPC_METHODS.START, input);
    useActionOperationSelector(readSnapshot); useActionOperation(address);
    const perform = createFrontDoorActionExecute(createDefaultActionExecutor(context));
    perform(unknownAction, {});
  ` }], specs, []);
  assert.deepEqual(report.findings.map(finding => finding.code), ['dynamic_action']);
});

test('resolves imported setting refs and semantic binding writes without allowing arbitrary read-only preferences', () => {
  const report = collectUiActionParity([
    { filePath: 'apps/ui/sources/components/settings/example.ts', content: `
      export const EDIT_SETTING = { anchor: 'appearance.mode' };
      export const modeBinding = { scope: 'local', access: 'read_write',
        commit: (local, value, writeLocal) => writeLocal({ themePreference: value }) };
      defineSettingsPage({ pageId: 'appearance', sections: { look: { settings: { mode: { storage: modeBinding } } } } });
    ` },
    { filePath: 'apps/ui/sources/components/Example.tsx', content: `
      import { EDIT_SETTING } from './settings/example';
      const commit = useSettingActionWriter(); commit(EDIT_SETTING, 'dark');
      const [, setTheme] = useLocalSettingMutable('themePreference'); setTheme('dark');
      const [, setLanguage] = useSettingMutable('preferredLanguage'); setLanguage('en');
      const [, setOther] = useSettingMutable('otherReadOnly'); setOther(true);
    ` },
  ], specs, [
    { anchor: 'appearance.mode', storage: { scope: 'local', access: 'read_write' } },
    { anchor: 'language.appLanguage', storage: { scope: 'account', key: 'preferredLanguage', access: 'read_only' } },
    { anchor: 'other.readOnly', storage: { scope: 'account', key: 'otherReadOnly', access: 'read_only' } },
  ]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['account:otherReadOnly']);
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set', 'settings.set']);
  assert.equal(report.exclusions.length, 1);
});

test('an unattached or agent-disabled semantic storage object cannot authorize a setting write', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const fake = { storage: { scope: 'local', access: 'read_write',
      commit: (local, value, writeLocal) => writeLocal({ unattached: value }) } };
    defineSettingsPage({ pageId: 'appearance', sections: { look: { settings: { privateMode: {
      storage: { scope: 'local', access: 'read_write', commit: (local, value, writeLocal) => writeLocal({ privateMode: value }) },
    } } } } });
    const [, setUnattached] = useLocalSettingMutable('unattached'); setUnattached(true);
    const [, setPrivate] = useLocalSettingMutable('privateMode'); setPrivate(true);
  ` }], specs, [{ anchor: 'appearance.privateMode', surfaces: { agent: false, mcp: false },
    storage: { scope: 'local', access: 'read_write' } }]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['local:unattached', 'local:privateMode']);
});

test('an Action payload may contain a domain-native actionId without registering a second Action', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx',
    content: `executor.execute('demo.edit', { actionId: 'domain.native_operation', input: {} });` }], specs, []);
  assert.deepEqual(report.actions.map(site => site.actionId), ['demo.edit']);
  assert.deepEqual(report.findings, []);
});

test('walks resolved conditional setting deltas and spreads instead of declaring known keys dynamic', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const apply = useApplySettings();
    const delta = flag ? { density: 'compact' } : { mystery: true };
    apply(delta);
    apply({ ...(flag ? { density: 'comfortable' } : {}), mystery: false });
    apply(current => ({ density: current.density === 'compact' ? 'comfortable' : 'compact' }));
  ` }], specs, [{ anchor: 'appearance.density', storage: { scope: 'account', key: 'density', access: 'read_write' } }]);
  assert.deepEqual(report.findings.map(finding => finding.operation), ['account:mystery', 'account:mystery']);
  assert.deepEqual(report.settings.map(site => site.key), ['density', 'mystery', 'density', 'mystery', 'density']);
});

test('consumes admitted semantic-owner deltas without treating a disabled declaration as writable', () => {
  const report = collectUiActionParity([{ filePath: 'apps/ui/sources/components/Example.tsx', content: `
    const [, setChoice] = useSettingMutable('coupledChoice'); setChoice({ mode: 'compact' });
    const [, setPrivate] = useSettingMutable('privateChoice'); setPrivate(true);
  ` }], specs, [
    { anchor: 'appearance.choice', storage: { scope: 'account', access: 'read_write' } },
    { anchor: 'appearance.privateChoice', storage: { scope: 'account', access: 'read_write' }, surfaces: { agent: false } },
  ], { settingBindings: new Map([['account:coupledChoice', ['appearance.choice']], ['account:privateChoice', ['appearance.privateChoice']]]) });
  assert.deepEqual(report.actions.map(site => site.actionId), ['settings.set']);
  assert.deepEqual(report.findings.map(site => site.operation), ['account:privateChoice']);
});
