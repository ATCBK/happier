import { describe, it, expect } from 'vitest';
import { z } from 'zod/mini';

import { applySettings, settingsDefaults, settingsParse } from './settings';
import { buildMachineTerminalSettingsPatch, resolveTerminalHost, resolveTerminalSpawnOptions } from './terminalSettings';
import { mergePendingSettingsIntoRawBaseline } from '@/sync/engine/settings/writeback/accountSettingsRawDeltaMerge';

// Exact nested reader from ui-web-v0.2.12/a357c65536ba89669422977d6f7daf9aa0d17e73.
const ReleasedSessionTmuxMachineOverrideSchema = z.object({
    useTmux: z.boolean(), sessionName: z.string(), isolated: z.boolean(), tmpDir: z.nullable(z.string()),
});

describe('resolveTerminalSpawnOptions', () => {
    it('returns null when tmux is disabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: false,
        };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toBeNull();
    });

    it('returns tmux spawn options when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'happy',
                isolated: true,
                tmpDir: null,
            },
        });
    });

    it('allows blank session name to use current/most recent tmux session', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: '   ',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {},
        };

        const resolved = resolveTerminalSpawnOptions({ settings, machineId: 'm1' });
        expect(resolved?.mode).toBe('tmux');
        if (resolved?.mode !== 'tmux') throw new Error('Expected tmux terminal host');
        expect(resolved.tmux.sessionName).toBe('');
    });

    it('supports per-machine overrides when enabled', () => {
        const settings: any = {
            ...settingsDefaults,
            sessionUseTmux: true,
            sessionTmuxSessionName: 'happy',
            sessionTmuxIsolated: true,
            sessionTmuxTmpDir: null,
            sessionTmuxByMachineId: {
                m1: {
                    useTmux: true,
                    sessionName: 'dev',
                    isolated: false,
                    tmpDir: '/tmp/tmux',
                },
            },
        };

        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'tmux',
            tmux: {
                sessionName: 'dev',
                isolated: false,
                tmpDir: '/tmp/tmux',
            },
        });
    });

    it('uses Herdr for eligible new sessions when selected globally', () => {
        const settings = { ...settingsDefaults, sessionTerminalHost: 'herdr' as const };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({
            mode: 'herdr',
            herdr: { sessionName: 'default' },
        });
    });

    it('lets a machine choose Zellij independently of the global host', () => {
        const settings = {
            ...settingsDefaults,
            sessionTerminalHost: 'herdr' as const,
            sessionTerminalHostByMachineId: { m1: 'zellij' as const },
            sessionTmuxByMachineId: {
                m1: { useTmux: false, sessionName: 'happy', isolated: true, tmpDir: null },
            },
        };
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'm1' })).toEqual({ mode: 'zellij' });
    });

    it('preserves the additive machine host after a released UI echoes only its parsed tmux map', () => {
        // Released ui-web-v0.2.12/a357c65536ba89669422977d6f7daf9aa0d17e73
        // strips nested terminalHost, preserves unknown top-level settings,
        // and writes the complete parsed tmux map when editing another machine.
        const rawBaseline = {
            sessionTerminalHost: 'none',
            sessionTerminalHostByMachineId: { a: 'herdr' },
            sessionTmuxByMachineId: {
                a: { useTmux: false, terminalHost: 'herdr', sessionName: 'work', isolated: false, tmpDir: '/tmp/a' },
                b: { useTmux: true, sessionName: 'edited', isolated: true, tmpDir: null },
            },
        };
        const releasedParsedMap = z.record(z.string(), ReleasedSessionTmuxMachineOverrideSchema).parse(rawBaseline.sessionTmuxByMachineId);
        expect(releasedParsedMap.a).not.toHaveProperty('terminalHost');
        const echo = mergePendingSettingsIntoRawBaseline({
            rawBaseline, pendingSettings: { sessionTmuxByMachineId: releasedParsedMap },
            normalizeForPersistedStorage: (value) => ({ value, changed: false }),
        }).outgoingRaw;
        const settings = settingsParse(echo);
        expect(resolveTerminalSpawnOptions({ settings, machineId: 'a' })).toEqual({ mode: 'herdr', herdr: { sessionName: 'default' } });
        const legacySameMachineEdit = applySettings(settings, {
            sessionTmuxByMachineId: { ...settings.sessionTmuxByMachineId, a: { ...settings.sessionTmuxByMachineId.a!, useTmux: true } },
        });
        expect(resolveTerminalSpawnOptions({ settings: legacySameMachineEdit, machineId: 'a' })).toEqual({ mode: 'tmux', tmux: { sessionName: 'work', isolated: false, tmpDir: '/tmp/a' } });
    });

    it('writes machine host and legacy flags together while preserving tmux options and siblings', () => {
        const original = settingsParse({ sessionTerminalHost: 'herdr', sessionTmuxByMachineId: {
            a: { useTmux: true, sessionName: '', isolated: false, tmpDir: '/tmp/a' },
            b: { useTmux: true, sessionName: 'b', isolated: true, tmpDir: null },
        } });
        const herdr = applySettings(original, buildMachineTerminalSettingsPatch({ settings: original, machineId: 'a', host: 'herdr' }));
        expect(herdr.sessionTmuxByMachineId.a).toEqual({ useTmux: false, sessionName: '', isolated: false, tmpDir: '/tmp/a' });
        expect(resolveTerminalHost({ settings: herdr, machineId: 'a' })).toBe('herdr');
        const none = applySettings(herdr, buildMachineTerminalSettingsPatch({ settings: herdr, machineId: 'a', host: 'none' }));
        expect(resolveTerminalSpawnOptions({ settings: none, machineId: 'a' })).toBeNull();
        const tmux = applySettings(none, buildMachineTerminalSettingsPatch({ settings: none, machineId: 'a', host: 'tmux' }));
        expect(resolveTerminalSpawnOptions({ settings: tmux, machineId: 'a' })).toEqual({ mode: 'tmux', tmux: { sessionName: '', isolated: false, tmpDir: '/tmp/a' } });
        const inherited = applySettings(herdr, buildMachineTerminalSettingsPatch({ settings: herdr, machineId: 'a', host: null }));
        expect(resolveTerminalHost({ settings: inherited, machineId: 'a' })).toBe('herdr');
        expect(inherited.sessionTmuxByMachineId.a).toBeUndefined();
        expect(inherited.sessionTerminalHostByMachineId.a).toBeUndefined();
        expect(tmux.sessionTmuxByMachineId.b).toEqual(original.sessionTmuxByMachineId.b);
    });

    it('preserves explicit global precedence and the released legacy boolean fallback', () => {
        const settings = settingsParse({ sessionTerminalHost: 'herdr', sessionUseTmux: true });
        expect(resolveTerminalHost({ settings, machineId: null })).toBe('herdr');
        const disabled = applySettings(settings, { sessionTerminalHost: 'legacy', sessionUseTmux: false });
        expect(resolveTerminalHost({ settings: disabled, machineId: null })).toBe('none');
    });
});
