import { describe, expect, it } from 'vitest';
import { defaultKeyboardCommands } from '../commands';
import { buildShortcutsSheetModel } from './shortcutsSheetModel';

describe('shortcut sheet model', () => {
  it('shows native hardware bindings on a tablet and web bindings in its Browser segment', () => {
    expect(buildShortcutsSheetModel({ platform: 'ios', surface: 'native', singleKeyShortcutsEnabled: true }).host).toBe('desktop');
    const labels = (host: 'desktop' | 'browser') => buildShortcutsSheetModel({
      platform: 'ios', surface: 'native', host, singleKeyShortcutsEnabled: true,
    }).groups.flatMap(group => group.rows).find(row => row.commandId === 'composer.abortConfirm')?.label;
    expect(labels('desktop')).toBe('Shift+Escape');
    expect(labels('browser')).toBe('Cmd+.');
  });
  it('groups every catalog command once and resolves browser bindings with the canonical resolver', () => {
    const model = buildShortcutsSheetModel({ platform: 'macos', host: 'browser', singleKeyShortcutsEnabled: true });
    const rows = model.groups.flatMap(group => group.rows);
    expect(new Set(rows.map(row => row.commandId)).size).toBe(defaultKeyboardCommands.length);
    expect(rows).toHaveLength(defaultKeyboardCommands.length);
    expect(model.host).toBe('browser');
    expect(model.groups.find(group => group.id === 'panes')?.rows.find(row => row.commandId === 'shell.column.toggle')?.label).toBe('Option+B');
    expect(buildShortcutsSheetModel({ platform: 'macos', host: 'desktop', singleKeyShortcutsEnabled: true }).groups
      .find(group => group.id === 'panes')?.rows.find(row => row.commandId === 'shell.column.toggle')?.label).toBe('Cmd+B');
  });
  it('honours disabled commands and overrides instead of maintaining a second binding policy', () => {
    const rows = buildShortcutsSheetModel({ platform: 'windows', host: 'browser', singleKeyShortcutsEnabled: false,
      disabledCommandIds: ['panes.main.toggle'], overrides: { 'shell.column.toggle': [{ binding: 'Alt+Shift+B' }] } }).groups.flatMap(group => group.rows);
    expect(rows.find(row => row.commandId === 'panes.main.toggle')?.label).toBeUndefined();
    expect(rows.find(row => row.commandId === 'shell.column.toggle')?.label).toBe('Alt+Shift+B');
  });
});
