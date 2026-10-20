import { describe, expect, it } from 'vitest';
import { buildKeyboardShortcutSettingsModel } from '@/components/settings/keyboard/keyboardShortcutsSettingsModel';
import { defaultKeyboardCommands } from './commands';
import { BUILT_IN_SETTINGS_METADATA_V1 } from '@happier-dev/protocol/actions/settings/builtInSettingsMetadata';

const isProgramCommand = (id: string) => /^(panes\.|shell\.column\.toggle$|media\.|search\.(files|symbols)$|files\.editor\.|review\.|editor\.selection\.ask$|files\.track\.toggle$|code\.)/.test(id);

describe('Files and Editor program bindings', () => {
  for (const platform of ['macos', 'windows', 'linux', 'ios', 'android'] as const) {
    for (const surface of ['native', 'web'] as const) {
      it.each([false, true])(`${platform}/${surface} has no program conflicts with single keys %s`, keyboardSingleKeyShortcutsEnabled => {
        const model = buildKeyboardShortcutSettingsModel({ platform, surface, settings: {
          commandPaletteEnabled: true, keyboardShortcutsV2Enabled: true, keyboardSingleKeyShortcutsEnabled,
          keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {},
        } });
        expect(model.conflicts.filter(conflict => conflict.commandIds.some(isProgramCommand))).toEqual([]);
      });
    }
  }
  it('includes pane commands in the audited catalog', () => {
    expect(defaultKeyboardCommands.filter(command => isProgramCommand(command.id)).map(command => command.id)).toContain('panes.main.toggle');
  });
  it('gives every program command one canonical Settings anchor before the page projects its rows', () => {
    expect(defaultKeyboardCommands.filter(command => isProgramCommand(command.id))
      .filter(command => BUILT_IN_SETTINGS_METADATA_V1.filter(setting => setting.anchor === `keyboard.${command.id}`).length !== 1)
      .map(command => command.id)).toEqual([]);
  });
});
