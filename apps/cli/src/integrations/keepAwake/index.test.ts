import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import { createKeepAwake } from './index';

function childBoundary() {
    const child = Object.assign(new EventEmitter(), {
        pid: 42, exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: vi.fn(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); return true; }),
    });
    child.stdin.on('finish', () => { child.emit('exit', 0, null); child.emit('close', 0, null); });
    return child;
}

function harness(platform: NodeJS.Platform, available = true) {
    const children: ReturnType<typeof childBoundary>[] = [];
    const spawn = vi.fn(() => {
        const child = childBoundary();
        children.push(child);
        return child as unknown as ChildProcess; // Real child-process/pipe boundary, with explicit readiness and exit edges.
    });
    const owner = createKeepAwake({ platform, daemonPid: 7, spawn, exists: () => available,
        resolveExecutable: () => available ? 'C:\\support\\happier-process-custody.exe' : null });
    const ready = () => {
        const child = children.at(-1)!;
        if (platform === 'darwin') child.emit('spawn');
        else child.stdout.write(platform === 'linux' ? 'happier-keep-awake-ready\n' : '{"holding":true,"v":1}\n');
    };
    return { owner, spawn, children, ready };
}

describe('daemon keep awake', () => {
    it.each(['linux', 'win32'] as const)('observes missing %s support even while Off or on battery, without starting a holder', async platform => {
        const h = harness(platform, false);
        const expected = { holding: false, unavailableReason: platform === 'win32' ? 'helper_missing' : 'no_inhibitor' };
        expect(h.owner.read()).toEqual(expected);
        await h.owner.update('off');
        expect(h.owner.read()).toEqual(expected);
        await h.owner.update('on_power', false);
        expect(h.owner.read()).toEqual(expected);
        expect(h.children).toHaveLength(0);
    });
    it.each(['darwin', 'linux', 'win32'] as const)('holds %s awake by default only after the OS holder is ready, with one holder', async platform => {
        const h = harness(platform);
        await h.owner.update();
        expect(h.owner.read().holding).toBe(false);
        h.ready();
        expect(h.owner.read().holding).toBe(true);
        await Promise.all([h.owner.update(), h.owner.update()]);
        expect(h.children).toHaveLength(1);
        expect(h.owner.read().holding).toBe(true);
        await h.owner.release();
        expect(h.owner.read().holding).toBe(false);
    });

    it.each(['linux', 'win32'] as const)('releases %s on battery and holds again on AC without a retry timer', async platform => {
        const h = harness(platform);
        await h.owner.update('on_power', false);
        expect(h.children).toHaveLength(0);
        await h.owner.update('on_power', true);
        h.ready();
        expect(h.owner.read().holding).toBe(true);
        await h.owner.update('on_power', false);
        expect(h.owner.read().holding).toBe(false);
        await h.owner.update('on_power', null);
        expect(h.children).toHaveLength(1);
        await h.owner.update('on_power', true);
        h.ready();
        expect(h.owner.read().holding).toBe(true);
        await h.owner.release();
    });

    it('uses macOS AC-only system assertion for On power, without a display assertion', async () => {
        const h = harness('darwin');
        await h.owner.update('on_power', false);
        expect(h.spawn.mock.calls[0]).toEqual(['/usr/bin/caffeinate', ['-s', '-w', '7'], expect.objectContaining({ detached: false })]);
        await h.owner.release();
    });

    it('holds nothing with no logind, even when the policy defaults On', async () => {
        const h = harness('linux', false);
        await h.owner.update();
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        expect(h.children).toHaveLength(0);
    });

    it('reports no_inhibitor when logind denies acquisition instead of claiming a live holder', async () => {
        const h = harness('linux');
        await h.owner.update();
        h.children[0].stderr.write('Failed to inhibit: Access denied');
        h.children[0].emit('exit', 1, null); h.children[0].emit('close', 1, null);
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        expect(h.children).toHaveLength(1);
        await h.owner.update();
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        await h.owner.update();
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        h.ready();
        expect(h.owner.read().holding).toBe(true);
        await h.owner.release();
    });

    it('reports helper_missing on Windows without staged support', async () => {
        const h = harness('win32', false);
        await h.owner.update();
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'helper_missing' });
        expect(h.children).toHaveLength(0);
    });

    it('retains a native Windows acquisition failure while Off instead of inferring permission from helper presence', async () => {
        const h = harness('win32');
        await h.owner.update();
        h.children[0].emit('exit', 1, null); h.children[0].emit('close', 1, null);
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        await h.owner.update('off');
        expect(h.owner.read()).toEqual({ holding: false, unavailableReason: 'no_inhibitor' });
        expect(h.children).toHaveLength(1);
    });

    it('withdraws holding on failure, and re-holds only on the next decision edge', async () => {
        const h = harness('win32');
        await h.owner.update(); h.ready();
        h.children[0].emit('exit', 5, null); h.children[0].emit('close', 5, null);
        expect(h.owner.read().holding).toBe(false);
        expect(h.children).toHaveLength(1);
        await h.owner.update(); h.ready();
        expect(h.children).toHaveLength(2);
        expect(h.owner.read().holding).toBe(true);
        await h.owner.release();
    });

    it('a late readiness line cannot restore holding after Off', async () => {
        const h = harness('win32');
        await h.owner.update();
        const child = h.children[0];
        await h.owner.release();
        child.stdout.write('{"holding":true,"v":1}\n');
        expect(h.owner.read().holding).toBe(false);
    });

    it.each(['darwin', 'linux', 'win32'] as const)('keeps one %s holder through repeated pending updates, then honours Off while retiring', async platform => {
        const h = harness(platform);
        await Promise.all([h.owner.update(), h.owner.update()]);
        expect(h.children).toHaveLength(1);
        expect(h.owner.read().holding).toBe(false);
        h.ready();
        expect(h.owner.read().holding).toBe(true);
        const previous = h.children[0];
        // The process boundary delays close after termination/EOF.
        previous.kill.mockImplementation(() => true);
        previous.stdin.removeAllListeners('finish');
        const changing = h.owner.update('on_power', true);
        await vi.waitFor(() => expect(h.owner.read().holding).toBe(false));
        const stopping = h.owner.release();
        previous.stdout.write('{"holding":true,"v":1}\n');
        previous.emit('exit', 0, null); previous.emit('close', 0, null);
        await Promise.all([changing, stopping]);
        expect(h.owner.read().holding).toBe(false);
        expect(h.children).toHaveLength(1);
    });
});
