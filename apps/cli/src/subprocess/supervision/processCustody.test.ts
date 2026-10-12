import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createProcessCustodyHandshakePath,
    createWindowsJobCustodyName,
    parseWindowsJobCustodyOwnerTag,
    joinProcessCustodyJob,
    releaseProcessCustodyJobHandle,
    formatDarwinNativeStartIdentity,
    formatWindowsJobCustodyStartIdentity,
    observeNativeDarwinProcessStartIdentity,
    parseProcessCustodyHandshakeLine,
    parseProcessCustodyStartIdentity,
    queryProcessCustodyJob,
    resolveProcessCustodyRuntimeExecutable,
    terminateProcessCustodyByJob,
    waitForProcessCustodyHandshake,
} from './processCustody';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(async (path) => {
        await rm(path, { recursive: true, force: true });
    }));
});

describe('process custody identity format', () => {
    it('formats and parses the tagged Windows job identity', () => {
        const jobName = createWindowsJobCustodyName('opaque-1');
        expect(jobName).toMatch(/^Local\\happier-svc09-.+$/u);
        const identity = formatWindowsJobCustodyStartIdentity(jobName);
        expect(identity).toBe(`winjob:${jobName}`);
        expect(parseProcessCustodyStartIdentity(identity)).toEqual({
            kind: 'win32-job',
            jobName,
        });
    });

    it('formats and parses the tagged Darwin native identity', () => {
        const identity = formatDarwinNativeStartIdentity(4242, { sec: 1754041400, usec: 123456 });
        expect(identity).toBe('darwin-proc:4242:1754041400:123456');
        expect(parseProcessCustodyStartIdentity(identity)).toEqual({
            kind: 'darwin-proc',
            pid: 4242,
            sec: 1754041400,
            usec: 123456,
        });
    });

    it('parses legacy and malformed identities as null instead of guessing', () => {
        expect(parseProcessCustodyStartIdentity('41:1754041400000')).toBeNull();
        expect(parseProcessCustodyStartIdentity('garbage')).toBeNull();
        expect(parseProcessCustodyStartIdentity('winjob:')).toBeNull();
        expect(parseProcessCustodyStartIdentity('darwin-proc:4242:1754041400:1000000')).toBeNull();
        expect(parseProcessCustodyStartIdentity('darwin-proc:0:1754041400:1')).toBeNull();
        expect(() => formatWindowsJobCustodyStartIdentity('  ')).toThrow(TypeError);
    });

    it('parses the post-assignment handshake only for the exact expected job', () => {
        const jobName = createWindowsJobCustodyName('opaque-2');
        expect(parseProcessCustodyHandshakeLine(
            `{"v":1,"pid":1234,"job":${JSON.stringify(jobName)}}`,
            jobName,
        )).toEqual({ pid: 1234, jobName });
        expect(parseProcessCustodyHandshakeLine(
            `{"v":1,"pid":1234,"job":${JSON.stringify(jobName)}}`,
            createWindowsJobCustodyName('opaque-3'),
        )).toBeNull();
        expect(parseProcessCustodyHandshakeLine('{"v":1,"pid":0,"job":"x"}', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('{"v":1,"pid":1234}', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('not json', 'x')).toBeNull();
        expect(parseProcessCustodyHandshakeLine('', 'x')).toBeNull();
    });

    it('issues unguessable private handshake paths', () => {
        expect(createProcessCustodyHandshakePath()).not.toBe(createProcessCustodyHandshakePath());
    });
});

describe('process custody runtime outcomes', () => {
    function fakeExec(stdout: string, code = 0) {
        if (code === 0) {
            return vi.fn(async (_file: string, _args: readonly string[]) => ({ stdout, stderr: '' }));
        }
        return vi.fn(async (_file: string, _args: readonly string[]) => {
            throw Object.assign(new Error('custody helper failed'), { code });
        });
    }

    it('keeps owner-held Job naming isolated by home scope and round-trips the canonical owner', () => {
        const tag = 'v1.0123456789ab.session.owner.with/slashes';
        const name = createWindowsJobCustodyName(tag);
        expect(parseWindowsJobCustodyOwnerTag(name)).toBe(tag);
        expect(createWindowsJobCustodyName('v1.abcdef012345.session.owner.with/slashes')).not.toBe(name);
        expect(parseWindowsJobCustodyOwnerTag('Local\\happier-owner-YmFk')).toBeNull();
        expect(parseWindowsJobCustodyOwnerTag(createWindowsJobCustodyName('opaque-id'))).toBeNull();
    });

    it('accepts only exact established owner-held custody and releases the original holder generation', async () => {
        const tag = 'v1.0123456789ab.terminal.owned';
        const job = createWindowsJobCustodyName(tag);
        const expected = { v: 1, state: 'joined', job, pid: 42, holderPid: 43, holderStartTimeMs: 1234, holderHandle: '18446744073709551600' };
        const joined = await joinProcessCustodyJob({ platform: 'win32', pid: 42, holderPid: 43, ownerTag: tag,
            executablePath: 'custody', execFile: fakeExec(JSON.stringify(expected)) });
        expect(joined).toEqual({ state: 'joined', jobName: job, pid: 42, holderPid: 43, holderStartTimeMs: 1234, holderHandle: expected.holderHandle });
        await expect(joinProcessCustodyJob({ platform: 'win32', pid: 42, holderPid: 43, ownerTag: tag,
            executablePath: 'custody', execFile: fakeExec(JSON.stringify({ ...expected, pid: 44 })) })).resolves.toEqual({ state: 'unavailable' });
        await expect(joinProcessCustodyJob({ platform: 'win32', pid: 42, holderPid: 43, ownerTag: tag,
            executablePath: 'custody', execFile: fakeExec('', 5) })).resolves.toEqual({ state: 'unavailable' });
        if (joined.state !== 'joined') throw new Error('join missing');
        const release = fakeExec('{"v":1,"state":"released"}');
        await expect(releaseProcessCustodyJobHandle({ custody: joined, executablePath: 'custody', execFile: release })).resolves.toBe(true);
        expect(release.mock.calls[0]?.[1]).toContain('--holder-start-time-ms=1234');
        expect(release.mock.calls[0]?.[1]).toContain(`--holder-handle=${expected.holderHandle}`);
    });

    it('maps the job query outcomes honestly', async () => {
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"absent"}\n'),
        })).resolves.toBe('absent');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"live","members":3}\n'),
        })).resolves.toBe('live');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('garbage'),
        })).resolves.toBe('unavailable');
        await expect(queryProcessCustodyJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('', 5),
        })).resolves.toBe('unavailable');
    });

    it('keeps membership-remaining distinct from proven absence', async () => {
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"absent"}\n'),
        })).resolves.toBe('absent');
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('{"v":1,"state":"members-remaining","members":2}\n'),
        })).resolves.toBe('members-remaining');
        await expect(terminateProcessCustodyByJob({
            executablePath: 'custody',
            jobName: 'Local\\j',
            execFile: fakeExec('', 3),
        })).resolves.toBe('members-remaining');
    });

    it('reads exact Darwin subsecond identity from a validated process census and refuses missing evidence', async () => {
        const snapshot = (native: string, pid = 4242, includeSelf = true) => JSON.stringify({
            v: 1, capturedAtMs: 1000, logicalCpus: 8,
            rows: [
                ...(includeSelf ? [{ pid: process.pid, ppid: 1, start: { startTimeMs: 1000 },
                    principal: { kind: 'uid', value: '1000' }, name: 'daemon', memory: null, cpuTimeUs: null }] : []),
                { pid, ppid: 1, start: { startTimeMs: 1754041400000, native },
                    principal: { kind: 'uid', value: '1000' }, name: 'runner', memory: null, cpuTimeUs: null },
            ],
        });
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec(snapshot('darwin-proc:4242:1754041400:123456')),
        })).resolves.toEqual({ sec: 1754041400, usec: 123456 });
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec(snapshot('darwin-proc:4242:1754041400:1000000')),
        })).resolves.toBeNull();
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec(snapshot('darwin-proc:99:1754041400:123456', 99)),
        })).resolves.toBeNull();
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody', pid: 4242,
            execFile: fakeExec(snapshot('darwin-proc:4242:1754041400:123456', 4242, false)),
        })).resolves.toBeNull();
        await expect(observeNativeDarwinProcessStartIdentity({
            executablePath: 'custody',
            pid: 4242,
            execFile: fakeExec('', 5),
        })).resolves.toBeNull();
    });
});

describe('post-assignment handshake', () => {
    it('consumes the marker exactly once and rejects foreign or malformed facts', async () => {
        const root = await mkdtemp(join(tmpdir(), 'process-custody-handshake-'));
        tempDirs.push(root);
        const handshakePath = join(root, 'handshake.json');
        const jobName = createWindowsJobCustodyName('opaque-4');
        await writeFile(
            handshakePath,
            `${JSON.stringify({ v: 1, pid: 4242, job: jobName })}\n`,
            'utf8',
        );
        const removals: string[] = [];
        await expect(waitForProcessCustodyHandshake({
            handshakePath,
            jobName,
            readFile: async (path) => await readFile(path, 'utf8'),
            removeFile: async (path) => {
                removals.push(path);
            },
            delay: async () => undefined,
        })).resolves.toEqual({ pid: 4242 });
        expect(removals).toEqual([handshakePath]);

        await writeFile(handshakePath, `${JSON.stringify({ v: 1, pid: 99, job: 'other' })}\n`, 'utf8');
        await expect(waitForProcessCustodyHandshake({
            handshakePath,
            jobName,
            readFile: async (path) => await readFile(path, 'utf8'),
            removeFile: async () => undefined,
            delay: async () => undefined,
        })).resolves.toBeNull();
    });

    it('answers null on timeout so callers fail custody closed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'process-custody-handshake-missing-'));
        tempDirs.push(root);
        await expect(waitForProcessCustodyHandshake({
            handshakePath: join(root, 'never.json'),
            jobName: 'Local\\j',
            timeoutMs: 25,
            delay: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
        })).resolves.toBeNull();
    });
});

describe('staged runtime resolution', () => {
    it('answers null without a staged helper on this host instead of guessing a path', () => {
        // This checkout has no staged daemon-support payload, so the only
        // honest answer is absence: callers fail closed on that.
        if (process.platform === 'linux') {
            expect(resolveProcessCustodyRuntimeExecutable('linux')).toBeNull();
        }
        expect(typeof createProcessCustodyHandshakePath()).toBe('string');
    });

    it('smokes the real helper on this platform when one is staged for live validation', async () => {
        const executablePath = resolveProcessCustodyRuntimeExecutable();
        if (!executablePath || process.platform !== 'darwin') {
            // Real helper smoke is a mac-host live lane; unit runs skip it.
            return;
        }
        const witness = await observeNativeDarwinProcessStartIdentity({ executablePath, pid: process.pid });
        expect(witness).not.toBeNull();
        expect(witness!.usec).toBeGreaterThanOrEqual(0);
        expect(witness!.usec).toBeLessThanOrEqual(999_999);
        // Cross-check the seconds against the independent `ps lstart` witness.
        const lstart = (
            await execFileAsync('ps', ['-o', 'lstart=', '-p', String(process.pid)])
        ).stdout.trim();
        expect(Math.trunc(Date.parse(lstart) / 1000)).toBe(witness!.sec);
    });
});
