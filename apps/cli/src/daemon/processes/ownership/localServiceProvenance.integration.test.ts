import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { censusRowToProcessFact } from '@/processes/census/processFacts';
import { normalizeLocalServiceScan } from '@/daemon/local/services/inventory/scanner';
import { listHappierProcessRoots } from '../roots/listHappierProcessRoots';
import { createProcessOwnershipRuntime } from './processOwnershipRuntime';

describe('disposable listener provenance', () => {
    it('projects a real same-principal agent-like listener through census, ownership and Services with secrets redacted', async () => {
        // This OS fixture has no auth, daemon, external address or personal-home state.
        const script = `const net = require('node:net');
            const server = net.createServer(socket => socket.end('agent-like fixture'));
            server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
            process.on('SIGTERM', () => server.close(() => process.exit(0)));`;
        const child = spawn(process.execPath, ['-e', script, '--', '--password', 'fixture secret words'], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = once(child, 'exit');
        try {
            const port = await new Promise<number>((resolve, reject) => {
                let output = '';
                child.on('error', reject);
                child.stdout.on('data', chunk => {
                    output += String(chunk);
                    const line = output.split('\n')[0];
                    if (line && output.includes('\n')) {
                        const value: unknown = JSON.parse(line);
                        if (typeof value === 'object' && value !== null && 'port' in value && typeof value.port === 'number') resolve(value.port);
                        else reject(new Error('Invalid disposable listener readiness'));
                    }
                });
                child.on('exit', () => reject(new Error('Disposable listener exited before readiness')));
            });
            const socket = createConnection({ host: '127.0.0.1', port });
            const [data] = await once(socket, 'data');
            socket.destroy();
            expect(String(data)).toBe('agent-like fixture');
            const runtime = createProcessOwnershipRuntime({ daemonScopeKey: '123456789abc',
                listRoots: snapshot => {
                    const observed = snapshot.rows.find(row => row.pid === child.pid);
                    if (!observed) throw new Error('Disposable listener absent from census');
                    return listHappierProcessRoots({ snapshot, daemonScopeKey: '123456789abc',
                        trackedSessions: [{ pid: observed.pid, happySessionId: 'fixture-session', processStartTimeMs: observed.start.startTimeMs }] });
                } });
            const view = await runtime.readOwners({ freshness: 'fresh' });
            expect(view.status).toBe('ok');
            if (view.status !== 'ok') throw new Error(`Native census unavailable: ${view.reason}`);
            const selfPrincipal = view.snapshot.rows.find(row => row.pid === process.pid)?.principal ?? null;
            const snapshot = normalizeLocalServiceScan({ machineId: 'fixture-machine', now: view.snapshot.capturedAtMs, previous: null,
                listeners: [{ address: '127.0.0.1', port, protocol: 'tcp', pid: child.pid }], workspaces: [], ownership: view.rows,
                processes: new Map(view.snapshot.rows.map(row => [row.pid, censusRowToProcessFact(row, selfPrincipal)])) });
            expect(snapshot.entries[0]).toMatchObject({ processOwnershipConfidence: 'high', provenance: { session: { id: 'fixture-session' } } });
            expect(snapshot.entries[0]?.provenance?.process?.command).not.toContain('fixture secret words');
        } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
            await exited;
        }
    });
});
