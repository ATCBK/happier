import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { completeHappierVoiceSession, fetchHappierVoiceToken, type VoiceTokenResponse } from './apiVoice';
import { getActiveServerSnapshot, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { resetServerProfilesRuntimeForTests } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch, type RuntimeFetch } from '@/utils/system/runtimeFetch';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createBundledHostedConversationService, createBundledConversationRuntimeHostLease } from '@/voice/registry/bundledConversationRuntimeHost';
import { voiceSettingsParse, writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { createElevenLabsSessionLifecycle } from '../../../../../../packages/plugins/elevenlabs/src/ui/voice/runtime/sessionLifecycle';
import { createElevenLabsSessionPreparationService } from '../../../../../../packages/plugins/elevenlabs/src/ui/voice/runtime/sessionPreparation';
import { ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';

const credentials = { token: 'test' } satisfies AuthCredentials;
const fetchSpy = vi.fn<RuntimeFetch>();
let credentialWrite: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> = null;

describe('apiVoice', () => {
    beforeEach(async () => {
        resetServerProfilesRuntimeForTests();
        fetchSpy.mockReset();
        // Substitute only network I/O; real Home selection and HTTP admission remain active.
        setRuntimeFetch(fetchSpy);
        const home = await upsertAndActivateServer({ serverUrl: 'https://api.example.test', scope: 'device' });
        expect(getActiveServerSnapshot()).toMatchObject({ serverId: home.id, serverUrl: home.serverUrl });
        credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, credentials);
        expect(credentialWrite).not.toBeNull();
    });
    afterEach(async () => {
        await credentialWrite?.rollback();
        credentialWrite = null;
        resetRuntimeFetch();
        resetServerProfilesRuntimeForTests();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe('fetchHappierVoiceToken', () => {
        it('returns allowed token payload when response is valid', async () => {
            const payload = {
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
                expiresAtMs: Date.now() + 60_000,
            } satisfies VoiceTokenResponse;
            fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toEqual(payload);
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/token');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({ sessionId: 'session-1' });
        });

        it('omits sessionId from request body when not provided', async () => {
            const payload = {
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                bindingNonce: 'nonce-1',
                expiresAtMs: Date.now() + 60_000,
            } satisfies VoiceTokenResponse;
            fetchSpy.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));

            const res = await fetchHappierVoiceToken(credentials, {});
            expect(res).toEqual(payload);
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/token');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({});
        });

        it('returns denied/upstream_error for 503 responses with invalid payloads', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({ malformed: true }), { status: 503 }));

            const res = await fetchHappierVoiceToken(credentials, { sessionId: 'session-1' });
            expect(res).toEqual({ allowed: false, reason: 'upstream_error' });
        });

        it('throws on successful responses with invalid body shape', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({
                allowed: true,
                token: 'voice_token',
                leaseId: 'lease-1',
                expiresAtMs: Date.now() + 60_000,
            }), { status: 200 }));

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
                'Voice token request returned an invalid response',
            );
        });

        it('throws on unexpected non-OK statuses', async () => {
            fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'internal' }), { status: 500 }));

            await expect(fetchHappierVoiceToken(credentials, { sessionId: 'session-1' })).rejects.toThrow(
                'Voice token request failed: 500',
            );
        });
    });

    describe('completeHappierVoiceSession', () => {
        it.each(['processing', 'transport'])('retries retained hosted lifecycle identity through HTTP after %s failure', async (failure) => {
            let completionAttempts = 0;
            const completedBodies: unknown[] = [];
            fetchSpy.mockImplementation(async (input, init) => {
                const url = String(input);
                if (url.endsWith('/v1/voice/token')) {
                    return new Response(JSON.stringify({
                        allowed: true, token: 'provider-token', leaseId: 'lease-1', bindingNonce: 'nonce-1', expiresAtMs: 12_000,
                    }));
                }
                expect(url).toBe('https://api.example.test/v1/voice/session/complete');
                expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test');
                completedBodies.push(JSON.parse(String(init?.body)));
                if (++completionAttempts === 1) {
                    if (failure === 'transport') throw new TypeError('network unavailable');
                    return new Response(JSON.stringify({ ok: false, reason: 'upstream_error' }), { status: 503 });
                }
                return new Response(JSON.stringify({ ok: true, durationSeconds: 5 }));
            });
            const service = createBundledHostedConversationService({ signal: new AbortController().signal, isCurrent: () => true });
            const host = createBundledConversationRuntimeHostLease();
            try {
                // Feed the provider's real preparation output into its lifecycle;
                // a copied sessionState could conceal a producer/consumer drift.
                const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
                const preparation = createElevenLabsSessionPreparationService({
                    providerId,
                    projectVoiceSettings(settings, id) {
                        const projection = host.host.projectVoiceSettings(settings, id);
                        // The public ElevenLabs runtime projects no independent assistant language.
                        return projection ? { ...projection, assistantLanguage: null } : null;
                    },
                    alert: () => { throw new Error('Unexpected hosted admission alert'); },
                });
                const prepared = await preparation.prepare({
                    controlSessionId: 'control-1', requestedTargetSessionId: 'session-1',
                    settings: { voiceSettingsV1: writeVoiceProviderSettingsConfig(
                        voiceSettingsParse({ providerId }), providerId, ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
                    ) },
                    credentials: { phase: 'prepare', mediated: null, raw: null },
                    hostedConversation: service, signal: new AbortController().signal,
                    platform: 'web', textOnly: false,
                });
                if (prepared.kind !== 'prepared') throw new Error('Expected hosted provider preparation');
                const lifecycle = createElevenLabsSessionLifecycle({ takeHostedConversation: () => service });
                lifecycle.prepared(1, prepared.session);
                lifecycle.started({ controlSessionId: 'control-1', conversationId: 'conversation-1', attemptId: 1, prepared: prepared.session });
                await expect(lifecycle.ended()).rejects.toThrow();
                await expect(service.complete({ providerConversationId: 'conversation-2' })).rejects.toMatchObject({
                    code: 'hosted_conversation_identity_mismatch',
                });
                await lifecycle.ended();
                await lifecycle.ended();
                expect(completedBodies).toEqual([
                    { leaseId: 'lease-1', providerConversationId: 'conversation-1' },
                    { leaseId: 'lease-1', providerConversationId: 'conversation-1' },
                ]);
            } finally {
                host.revoke();
            }
        });

        it('passes an AbortSignal to fetch', async () => {
            fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

            await completeHappierVoiceSession(credentials, {
                leaseId: 'lease-1',
                providerConversationId: 'conv-1',
            });
            const [url, init] = fetchSpy.mock.calls[0]!;
            expect(String(url)).toBe('https://api.example.test/v1/voice/session/complete');
            expect(init?.method).toBe('POST');
            const headers = new Headers(init?.headers);
            expect(headers.get('Authorization')).toBe('Bearer test');
            expect(headers.get('Content-Type')).toBe('application/json');
            expect(JSON.parse(String(init?.body))).toEqual({ leaseId: 'lease-1', providerConversationId: 'conv-1' });
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        });

        it('throws when the server response is not ok without including response body text', async () => {
            fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));

            try {
                await completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                });
                throw new Error('expected rejection');
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                if (!(error instanceof Error)) throw error;
                expect(error.message).toBe('Voice session complete failed (503)');
                expect(error.message).not.toContain('upstream down');
            }
        });

        it('throws without suffix when response.text() itself fails', async () => {
            // A failed response-body stream is a genuine fetch boundary failure.
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.error(new Error('cannot read body'));
                },
            });
            fetchSpy.mockResolvedValue(new Response(body, { status: 500 }));

            await expect(
                completeHappierVoiceSession(credentials, {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                }),
            ).rejects.toThrow('Voice session complete failed (500)');
        });

        it('aborts when completion request exceeds timeout', async () => {
            vi.useFakeTimers();

            fetchSpy.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (signal?.aborted) {
                    abort();
                    return;
                }
                signal?.addEventListener('abort', abort, { once: true });
            }));

            const promise = completeHappierVoiceSession(
                credentials,
                {
                    leaseId: 'lease-1',
                    providerConversationId: 'conv-1',
                },
                { timeoutMs: 5 },
            );
            const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
            await vi.advanceTimersByTimeAsync(5);
            await rejection;
            expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        });
    });
});
