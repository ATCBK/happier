import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { logger } from './logging/log';
import { timeWebLatencyPhase, withWebLatencyTrace } from './webLatencyTrace';
import { enableMonitoring } from '@/app/api/utils/enableMonitoring';

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('web latency request correlation', () => {
    it('links nested database spans and records safe failure outcomes without exception content', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const requestId = '23b2ed82-2ef7-4e4e-af0f-f64d599a08c6';
        const failure = Object.assign(new Error('private database input'), { code: 'P2010', meta: { code: '40P01' } });
        await expect(withWebLatencyTrace(requestId, () => timeWebLatencyPhase('db.transaction.attempt',
            () => timeWebLatencyPhase('db.raw.$queryRawUnsafe', () => { throw failure; }))))
            .rejects.toBe(failure);
        const records = sink.mock.calls.map(([record]) => record).filter(
            (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
        );
        const transaction = records.find(record => record.phase === 'db.transaction.attempt');
        const query = records.find(record => record.phase === 'db.raw.$queryRawUnsafe');
        expect(transaction).toMatchObject({ requestId, spanId: expect.any(Number), status: 'failed', code: 'P2010', sqlState: '40P01' });
        expect(query).toMatchObject({ requestId, spanId: expect.any(Number), parentSpanId: transaction?.spanId, status: 'failed' });
        expect(query?.spanId).not.toBe(transaction?.spanId);
        expect(JSON.stringify(records)).not.toContain('private database input');
    });

    it('correlates ordinary concurrent HTTP reads through the real monitoring hooks', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableMonitoring(app);
        app.addHook('preHandler', async () => {
            await timeWebLatencyPhase('probe.admission', async () => { await Promise.resolve(); });
        });
        app.get<{ Params: { id: string } }>('/trace/:id', async (request) => {
            await timeWebLatencyPhase(`probe.${request.params.id}`, async () => { await Promise.resolve(); });
            return { ok: true };
        });
        try {
            const responses = await Promise.all([
                app.inject('/trace/a?private=must-not-be-logged'),
                app.inject('/trace/b?private=must-not-be-logged'),
            ]);
            expect(responses.map(response => response.json())).toEqual([{ ok: true }, { ok: true }]);
            const records = sink.mock.calls.map(([record]) => record).filter(
                (record): record is Record<string, unknown> => typeof record === 'object' && record !== null,
            );
            const first = records.find(record => record?.phase === 'probe.a');
            const second = records.find(record => record?.phase === 'probe.b');
            expect(first).toEqual(expect.objectContaining({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) }));
            expect(second).toEqual(expect.objectContaining({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u) }));
            expect(first?.requestId).not.toBe(second?.requestId);
            for (const requestId of [first?.requestId, second?.requestId]) {
                expect(records).toEqual(expect.arrayContaining([
                    expect.objectContaining({ phase: 'probe.admission', requestId }),
                    expect.objectContaining({ phase: 'http.GET./trace/:id', requestId }),
                ]));
            }
            expect(JSON.stringify(records)).not.toContain('must-not-be-logged');
        } finally {
            await app.close();
        }
    });

    it.each(['', 'new-session-attempt-'])('retains the existing %s request identity across asynchronous dispatch', async (prefix) => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        // Pino is the logging output boundary; dispatch and context propagation remain real.
        const sink = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        const requestId = `${prefix}23b2ed82-2ef7-4e4e-af0f-f64d599a08c6`;
        const failure = new Error('dispatch failed');

        await expect(withWebLatencyTrace(requestId, async () => {
            await Promise.resolve();
            return await timeWebLatencyPhase('action.http.dispatch', async () => { throw failure; });
        })).rejects.toBe(failure);

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'action.http.dispatch', requestId,
        }), '[web-latency]');
    });

    it('emits above the stack warn threshold so an opted-in trace is never filtered from the server log', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
        const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        await timeWebLatencyPhase('dispatch', () => 'ok');
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ module: 'web-latency', phase: 'dispatch' }), '[web-latency]');
        expect(info).not.toHaveBeenCalled();
    });

    it('omits arbitrary input and leaves tracing disabled unless requested', async () => {
        const sink = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        await withWebLatencyTrace('private free-form input', () => timeWebLatencyPhase('dispatch', () => 'ok'));
        expect(sink).toHaveBeenCalledWith(expect.not.objectContaining({ requestId: expect.anything() }), '[web-latency]');
        sink.mockClear();
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '0');
        expect(await withWebLatencyTrace('23b2ed82-2ef7-4e4e-af0f-f64d599a08c6', () => timeWebLatencyPhase('dispatch', () => 'ok'))).toBe('ok');
        expect(sink).not.toHaveBeenCalled();
    });
});
