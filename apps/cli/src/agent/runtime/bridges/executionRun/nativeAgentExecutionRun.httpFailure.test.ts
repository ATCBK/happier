import axios from 'axios';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';

import { ExecutionRunErrorSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { logger } from '@/ui/logger';
import { projectExecutionRunError } from './errors';
import { createNativeAgentExecutionRunHostRuntime } from './nativeAgentExecutionRun';

afterEach(() => vi.restoreAllMocks());

it.each([
    { phase: 'open', path: '/v1/run-admission', diagnosticPath: '/v1/run-admission', status: 409, domainCode: 'run_admission_conflict' },
    // Wrong-route binding must identify the actual HTTP failure, not blame the intended route.
    { phase: 'send', path: '/wrong-resource', diagnosticPath: '/wrong-resource', status: 404, domainCode: 'resource_not_found' },
    { phase: 'open', path: '/v1/run-admission/df57f63c-6f69-4a27-871f-a35b205e4e96',
        diagnosticPath: '/v1/run-admission/:redacted', status: 409, domainCode: 'run_admission_conflict' },
    { phase: 'open', path: '/v1/run-admission/sk_live_abCDef0123456789',
        diagnosticPath: '/v1/run-admission/:redacted', status: 409,
        domainCode: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.sig', omitDomainCode: true },
    { phase: 'open', path: '/v1/run-admission/single-use-query',
        diagnosticPath: '/v1/run-admission/single-use-query', status: 409,
        domainCode: 'run_admission_conflict', singleUseSerializer: true },
] as const)('attributes an external Agent $phase HTTP failure before redaction ($path)', async (vector) => {
    const { phase, path, diagnosticPath, status, domainCode } = vector;
    const warn = vi.spyOn(logger, 'warnLocalFile');
    const server = createServer((request, response) => {
        response.writeHead(request.url?.startsWith('/v1/run-admission') ? 409 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: phase === 'send' ? { code: domainCode } : domainCode, message: 'private-response-value' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test HTTP address');
    const origin = `http://127.0.0.1:${address.port}`;
    let serialized = false;
    const request = () => axios.post(`${path}?token=private-query-value`, { prompt: 'private-prompt-value' }, {
        baseURL: origin.replace('://', '://private-user-value:private-pass-value@'),
        headers: { authorization: 'Bearer private-header-value' },
        ...('singleUseSerializer' in vector ? { params: { token: 'private-query-value' }, paramsSerializer: {
            serialize: () => {
                if (serialized) throw new Error('Query serializer must not run again during error projection');
                serialized = true;
                return 'token=private-query-value';
            },
        } } : {}),
        proxy: false,
    });
    // An independently authored Agent is the system boundary. The host's native
    // Run admission, sanitization and strict public error consumer remain real.
    const host = createNativeAgentExecutionRunHostRuntime({
        runtime: { executionRuns: { async open() {
            if (phase === 'open') await request();
            return {
                async send() { await request(); return { status: 'admitted' }; },
                async stop() { return { status: 'notRunning' }; },
                watch() { return { dispose() {} }; },
                async dispose() {},
            };
        } } },
        lease: { pluginId: 'acme.http-agent', pluginVersion: '1.0.0', agentId: 'acme.http-agent/default',
            localAgentId: 'default', occurrenceId: 'http-failure', isCurrent: () => true },
        options: { cwd: '/repo', runId: 'http-failure-run', scope: 'detached', backendId: 'acme.http-agent/default',
            permissionMode: 'read_only', start: { intent: 'delegate', runClass: 'bounded', retentionPolicy: 'ephemeral' } },
        supportsResume: false,
    });
    try {
        let failure: unknown;
        try {
            await host.provisionRuntime({ initialPrompt: 'Initial input' });
            if (phase === 'send') await host.deliverInput('http-failure-run', { text: 'Follow up' });
        } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'ERR_BAD_REQUEST' });
        const publicFailure = ExecutionRunErrorSchema.parse(projectExecutionRunError(failure));
        expect(publicFailure).toMatchObject({ code: 'ERR_BAD_REQUEST' });
        const httpRecords = warn.mock.calls.filter(([message]) => message === '[EXECUTION RUN] HTTP request failed');
        expect(httpRecords).toEqual([['[EXECUTION RUN] HTTP request failed', {
            runId: 'http-failure-run', method: 'POST', origin, path: diagnosticPath, status,
            ...('omitDomainCode' in vector ? {} : { domainCode }),
        }]]);
        const diagnostics = JSON.stringify({ httpRecords, publicFailure });
        for (const privateValue of ['private-query-value', 'private-header-value', 'private-prompt-value', 'private-response-value',
            'private-user-value', 'private-pass-value', 'df57f63c-6f69-4a27-871f-a35b205e4e96',
            'sk_live_abCDef0123456789', ...('omitDomainCode' in vector ? [domainCode] : [])]) {
            expect(diagnostics).not.toContain(privateValue);
        }
    } finally {
        await host.dispose();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});
