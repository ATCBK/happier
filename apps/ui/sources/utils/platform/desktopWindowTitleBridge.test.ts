import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { describeNotImplemented, runCommand } from '../../../../desktop/src/main/commands/registry';
import { isKnownTauriDesktopCommand } from '../../../../desktop/src/main/commands/inventory';
import { createHarness } from '../../../../desktop/src/main/commands/registry.testkit';
import type { CommandContext } from '../../../../desktop/src/main/commands/types';

import * as windowBridge from './desktopWindowBridge';

describe('desktop window title transport', () => {
    beforeEach(() => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        vi.stubGlobal('__TAURI__', undefined);
        vi.stubGlobal('isTauri', undefined);
        vi.stubGlobal('navigator', { userAgent: 'Browser' });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('leaves browser titles to the document consumer without invoking a desktop host', async () => {
        await expect(windowBridge.setDesktopWindowTitle('Workspace')).resolves.toBeUndefined();
    });

    it.each(['Tauri', 'Electron/43.4.0'])('passes exact current titles through the %s IPC bridge without requiring custom chrome', async (userAgent) => {
        const titles: string[] = [];
        // The native IPC boundary records the OS title; host detection and transport stay real.
        const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
            expect(command).toBe('desktop_set_window_title');
            expect(typeof args?.title).toBe('string');
            titles.push(args?.title as string);
        });
        vi.stubGlobal('navigator', { userAgent });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke });

        for (const title of ['Session ✨ — Happier', 'Next checkout', '']) {
            await windowBridge.setDesktopWindowTitle(title);
        }

        expect(titles).toEqual(['Session ✨ — Happier', 'Next checkout', '']);
    });

    it('preserves native failures for the owning title consumer to handle', async () => {
        const failure = new Error('native window unavailable');
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => { throw failure; } });

        await expect(windowBridge.setDesktopWindowTitle('Workspace')).rejects.toBe(failure);
    });

    it('updates the invoking Electron window through the real shared bridge and command registry', async () => {
        const { registry, context } = createHarness();
        let nativeTitle = 'Happier';
        // BrowserWindow and IPC are OS boundaries; the transport and host registry remain real.
        const window = {
            setTitle: (title: string) => { nativeTitle = title; },
        } as NonNullable<CommandContext['window']>;
        vi.stubGlobal('navigator', { userAgent: 'Electron/43.4.0' });
        vi.stubGlobal('__TAURI_INTERNALS__', {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                const outcome = await runCommand(registry, command, args ?? {}, { ...context, window });
                if (outcome.kind === 'not-implemented') {
                    throw new Error(describeNotImplemented(outcome));
                }
                return outcome.value;
            },
        });

        for (const title of ['Session ✨ — Happier', 'Next checkout', '']) {
            await windowBridge.setDesktopWindowTitle(title);
            expect(nativeTitle).toBe(title);
        }
        expect(isKnownTauriDesktopCommand('desktop_set_window_title')).toBe(true);
        await expect(runCommand(registry, 'desktop_set_window_title', { title: 1 }, { ...context, window })).rejects.toThrow();
        await expect(runCommand(registry, 'desktop_set_window_title', { title: 'Workspace' }, context)).rejects.toThrow();
        expect(nativeTitle).toBe('');

        const failure = new Error('native window closed');
        // Electron is the OS boundary; this failure fixture exposes only the consumed title method.
        const closedWindow = { setTitle: () => { throw failure; } } as unknown as NonNullable<CommandContext['window']>;
        await expect(runCommand(registry, 'desktop_set_window_title', { title: 'Workspace' }, { ...context, window: closedWindow })).rejects.toBe(failure);
    });

    it('exposes the title operation through Tauri registration and the main-window capability', () => {
        // Native command registration and ACLs are build-time configuration, inspected at their owners.
        const nativeFile = (path: string) => readFileSync(new URL(`../../../src-tauri/${path}`, import.meta.url), 'utf8');
        expect(nativeFile('src/lib.rs').includes('window_chrome::desktop_set_window_title,')).toBe(true);
        expect(nativeFile('build.rs').includes('"desktop_set_window_title",')).toBe(true);
        const capability = JSON.parse(nativeFile('capabilities/default.json')) as { windows: string[]; permissions: string[] };
        expect(capability.windows).toContain('main');
        expect(capability.permissions).toContain('allow-desktop-set-window-title');
    });
});
