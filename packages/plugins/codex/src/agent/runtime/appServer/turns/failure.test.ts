import { describe, expect, it } from 'vitest';

import {
    createCodexAppServerTurnFailure,
    formatCodexAppServerErrorForUi,
    isCodexAppServerContextWindowExhaustedError,
    isCodexAppServerTemporaryRecoverableTurnFailureError,
    readCodexAppServerTurnFailureDiagnostic,
} from './failure.js';

describe('createCodexAppServerTurnFailure', () => {
    it.each(['PRIVATE_UPSTREAM_DETAIL', "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."])(
        'retains a native flattened model_not_found code without classifying upstream prose: %s', message => {
        const failure = createCodexAppServerTurnFailure({ value: { turn: { error: {
            codexErrorInfo: 'other',
            message: `HTTP 400: ${JSON.stringify({ error: {
                type: 'invalid_request_error', code: 'model_not_found', param: null,
                message,
            } })}`,
        } } } });
        expect(failure).toMatchObject({ code: 'provider_model_not_found' });
        expect(readCodexAppServerTurnFailureDiagnostic(failure).providerErrorCode).toBe('model_not_found');
        expect(failure).toMatchObject({ runtimeAuthClassification: null });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    });

    it.each([
        'The selected model is not supported.',
        'HTTP 400: {"error":{"code":"model_not_found"}',
        'HTTP 400: {"error":{"code":"invalid_request_error","message":"model_not_found"}}',
    ])('does not infer a model refusal from prose or malformed envelopes: %s', message => {
        const failure = createCodexAppServerTurnFailure({ value: { error: { message, codexErrorInfo: 'other' } } });
        expect(failure).not.toHaveProperty('code');
        expect(readCodexAppServerTurnFailureDiagnostic(failure).providerErrorCode).toBe('Other');
    });

    it.each([
        { http_connection_failed: { http_status_code: 403 } },
        { httpConnectionFailed: { httpStatusCode: 403 } },
    ])('retains structured HTTP failure status without provider text: %j', codexErrorInfo => {
        const failure = createCodexAppServerTurnFailure({ value: { turn: { error: {
            message: 'PRIVATE_BODY_AND_CREDENTIAL', additionalDetails: 'PRIVATE_PROMPT', codexErrorInfo,
        } } } });
        expect(readCodexAppServerTurnFailureDiagnostic(failure)).toMatchObject({
            providerErrorCode: 'HttpConnectionFailed', httpStatus: 403,
        });
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    });

    it.each([null, '403', 403.5, 99, 600])('omits invalid structured HTTP status %j', httpStatusCode => {
        const failure = createCodexAppServerTurnFailure({ value: { error: {
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode } }, message: 'PRIVATE_BODY',
        } } });
        expect(readCodexAppServerTurnFailureDiagnostic(failure)).not.toHaveProperty('httpStatus');
        expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    });

    it('retains only closed provider failure reasons for failure logging', () => {
        const failure = createCodexAppServerTurnFailure({ value: { error: {
            message: 'secret credential and transcript', codexErrorInfo: 'ContextWindowExceeded',
        } } });
        expect(failure).toMatchObject({ failureReason: 'context_window_exceeded', providerErrorCode: 'ContextWindowExceeded' });
        const unknown = createCodexAppServerTurnFailure({ value: { error: {
            message: 'secret credential and transcript', codexErrorInfo: 'secret-credential',
        } } });
        expect(unknown).toMatchObject({ failureReason: 'unclassified_provider_error' });
        expect(unknown).not.toHaveProperty('providerErrorCode');
        expect(JSON.stringify(unknown)).not.toContain('secret');
    });
    it('preserves bounded model entitlement evidence for host recovery', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    type: 'invalid_request_error',
                    message: "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
                },
            },
            authContext: { profileId: 'free-account', groupId: 'happier' },
        });

        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'plan',
            limitCategory: 'plan_invalid',
            quotaScope: 'model',
            providerLimitId: 'gpt-5.6-sol',
        });
    });

    it('carries structured runtime-auth classification for Codex usage-limit errors', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: 'Usage limit reached',
                    codexErrorInfo: 'UsageLimitExceeded',
                    resets_at: '2026-05-17T15:30:00.000Z',
                    retry_after_ms: 90_000,
                    plan_type: 'plus',
                    rate_limits: { primary: { used_percent: 100 } },
                },
            },
            authContext: { profileId: 'leeroy', groupId: 'happier' },
            sourceAccountIdentity: {
                providerAccountId: 'acct_source',
                accountLabel: 'source@example.test',
                profileId: 'runtime-profile',
                groupId: 'runtime-group',
                generation: 42,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });

        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'leeroy',
            groupId: 'happier',
            resetsAtMs: Date.parse('2026-05-17T15:30:00.000Z'),
            retryAfterMs: 90_000,
            planType: 'plus',
            source: 'structured_provider_error',
            sourceProviderAccountId: 'acct_source',
            sourceAccountLabel: 'source@example.test',
            groupGeneration: 42,
            expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
        });
        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification)
            .not.toHaveProperty('rateLimits');
    });

    it('uses failure-time runtime identity when separate auth context is unavailable', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: 'Usage limit reached',
                    codexErrorInfo: 'UsageLimitExceeded',
                },
            },
            sourceAccountIdentity: {
                providerAccountId: 'acct_source',
                accountLabel: 'source@example.test',
                profileId: 'runtime-profile',
                groupId: 'runtime-group',
                generation: 42,
            },
        });

        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'runtime-profile',
            groupId: 'runtime-group',
            sourceProviderAccountId: 'acct_source',
            sourceAccountLabel: 'source@example.test',
            groupGeneration: 42,
        });
    });

    it('marks context-window failures only from structured Codex app-server payloads', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'Input rejected.',
                        codex_error_info: 'context_window_exceeded',
                    },
                },
            },
        });

        expect(isCodexAppServerContextWindowExhaustedError(failure)).toBe(true);
        const unclassifiedFailure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'Codex ran out of room in the context window.',
                        codex_error_info: 'other',
                    },
                },
            },
        });
        expect(isCodexAppServerContextWindowExhaustedError(unclassifiedFailure, { structuredOnly: true })).toBe(false);
        expect(isCodexAppServerContextWindowExhaustedError(
            new Error('Codex ran out of room in the context window.'),
            { structuredOnly: true },
        )).toBe(false);
    });

    it('requires native structured context evidence when requested while preserving message compatibility', () => {
        const proseFailure = createCodexAppServerTurnFailure({
            value: { error: { message: 'Codex ran out of room in the context window.', codexErrorInfo: 'Other' } },
        });
        const structuredFailure = createCodexAppServerTurnFailure({
            value: { error: { message: 'Input rejected.', codexErrorInfo: 'ContextWindowExceeded' } },
        });

        expect(isCodexAppServerContextWindowExhaustedError(proseFailure)).toBe(true);
        expect(isCodexAppServerContextWindowExhaustedError(proseFailure, { structuredOnly: true })).toBe(false);
        expect(isCodexAppServerContextWindowExhaustedError(structuredFailure, { structuredOnly: true })).toBe(true);
        expect(isCodexAppServerContextWindowExhaustedError(
            new Error('Codex ran out of room in the context window.'),
            { structuredOnly: true },
        )).toBe(false);
    });

    it('marks selected-model capacity failures as temporary recoverable failures', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'Selected model is at capacity. Please try a different model.',
                        codex_error_info: 'other',
                    },
                },
            },
        });

        expect(isCodexAppServerTemporaryRecoverableTurnFailureError(failure)).toBe(true);
        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'capacity',
            limitCategory: 'capacity',
            quotaScope: 'provider',
            serviceId: 'openai-codex',
        });
    });

    it('marks provider high-demand failures as temporary recoverable failures', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'The service is currently experiencing high demand. Please try again later.',
                        codex_error_info: 'other',
                    },
                },
            },
        });

        expect(isCodexAppServerTemporaryRecoverableTurnFailureError(failure)).toBe(true);
        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'capacity',
            limitCategory: 'capacity',
            quotaScope: 'provider',
            serviceId: 'openai-codex',
        });
    });

    it('formats non-empty messages for UI without double-prefixing error text', () => {
        expect(formatCodexAppServerErrorForUi(new Error('provider failed'))).toBe('Error: provider failed');
        expect(formatCodexAppServerErrorForUi(new Error('Error: provider failed'))).toBe('Error: provider failed');
    });

    it('does not expose provider failure prose through the terminal Error or UI formatter', () => {
        const providerMessageSentinel = 'VOICE_PRIVATE_FAILURE_MESSAGE_SENTINEL';
        const providerDetailsSentinel = 'VOICE_PRIVATE_FAILURE_DETAILS_SENTINEL';
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: `provider rejected ${providerMessageSentinel}`,
                    additional_details: providerDetailsSentinel,
                },
            },
        });

        expect(failure.message).toBe('Codex app-server turn failed.');
        expect(failure.stack ?? '').not.toContain(providerMessageSentinel);
        expect(failure.stack ?? '').not.toContain(providerDetailsSentinel);
        expect(formatCodexAppServerErrorForUi(failure)).toBe('Error: Codex app-server turn failed.');
    });
});
