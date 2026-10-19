import { describe, expect, it } from "vitest";

import { isRestrictedAuthTokenDeniedForRoute, readRestrictedCredentialRouteField, resolveApiTokenSessionActionForRoute, isExternalActionSessionRoutePurposeAllowed } from "./apiTokenRouteAdmission";
import { VerifiedEphemeralSessionRunnerPrincipalSchema } from '@happier-dev/protocol/ephemeralRunner/principal';
import { readSessionAccessAuthenticationFromRequest } from '@/app/session/access/sessionAccessAuthentication';

const principal = {
    accountId: "account-1", principalId: "token-1", credentialId: "token-1",
    authority: "account_automation" as const, expiresAt: null, parentTokenId: null,
    grant: {
        v: 1 as const, actions: { families: [], ids: ["session.message.send"] },
        targets: { sessions: ["session-1"], machines: [] }, approve: false,
        origins: [], models: null, permissionModes: null, create: null,
    },
};

describe("scoped API-token route admission", () => {
    it('admits reset-start effects only on their exact Pending update and withdrawal purposes', () => {
        const set = { method: 'PATCH', routeOptions: { url: '/v2/sessions/:sessionId/pending/:localId/action', config: { apiTokenSessionAction: 'session.message.send' } },
            body: { requestedAction: { v: 1, kind: 'reset_start', reset: {
                source: { ref: { service: { pluginId: 'example.usage', localId: 'usage' }, accountId: 'connected-account' }, bindingKind: 'account' },
                recordId: 'paug_v1_abcdefgh', meterId: 'weekly', witness: { id: 'history', observedAtMs: 100 },
            } } } };
        expect(isExternalActionSessionRoutePurposeAllowed(set, 'session.pending.resetStart.set')).toBe(true);
        const initial = { method: 'POST', routeOptions: { url: '/v2/sessions/:sessionId/pending', config: { apiTokenSessionAction: 'session.message.send' } },
            body: { localId: 'new-held-work', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hold' } } },
                requestedAction: set.body.requestedAction } };
        expect(isExternalActionSessionRoutePurposeAllowed(initial, 'session.pending.resetStart.set')).toBe(true);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...initial, body: { ...initial.body, resumeWhenAvailable: true } }, 'session.pending.resetStart.set')).toBe(false);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...initial, body: { ...initial.body, requestedAction: { v: 1, kind: 'enqueue' } } }, 'session.pending.resetStart.set')).toBe(false);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...set, body: { requestedAction: { v: 1, kind: 'send_now' } } }, 'session.pending.resetStart.set')).toBe(false);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...set, routeOptions: { ...set.routeOptions, url: '/v2/sessions/:sessionId/pending' } }, 'session.pending.resetStart.set')).toBe(false);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...set, routeOptions: { ...set.routeOptions, url: '/v2/sessions/:sessionId/pending/:localId' } }, 'session.pending.resetStart.set')).toBe(false);
        const cancel = { method: 'POST', body: {}, routeOptions: { url: '/v2/sessions/:sessionId/pending/:localId/withdraw', config: { apiTokenSessionAction: 'session.pending.withdraw' } } };
        expect(isExternalActionSessionRoutePurposeAllowed(cancel, 'session.pending.resetStart.cancel')).toBe(true);
        expect(isExternalActionSessionRoutePurposeAllowed({ ...cancel, method: 'DELETE' }, 'session.pending.resetStart.cancel')).toBe(false);
        expect(isExternalActionSessionRoutePurposeAllowed(cancel, 'session.pending.resetStart.set')).toBe(false);
    });
    it('selects exact withdrawal authority without broadening the legacy deletion action', () => {
        const routeOptions = { config: { apiTokenSessionAction: 'session.message.send' as const,
            apiTokenSessionActionWhen: { field: 'withdraw' as const, equals: 'true' as const, actionId: 'session.pending.withdraw' as const } } };
        expect(resolveApiTokenSessionActionForRoute({ routeOptions, query: {} })).toBe('session.message.send');
        expect(resolveApiTokenSessionActionForRoute({ routeOptions, query: { withdraw: 'true' } })).toBe('session.pending.withdraw');
        expect(resolveApiTokenSessionActionForRoute({ routeOptions, query: { withdraw: ['true', 'false'] } })).toBeUndefined();
        expect(resolveApiTokenSessionActionForRoute({ routeOptions, query: { withdraw: 'yes' } })).toBeUndefined();
    });
    it("binds exactly one Session query selector and refuses combined or absent selectors", () => {
        const selector = ["query.sessionId", "query.sessionAccessSessionId"] as const;
        expect(readRestrictedCredentialRouteField({ query: { sessionId: "session-1" } }, selector)).toBe("session-1");
        expect(readRestrictedCredentialRouteField({ query: { sessionAccessSessionId: "session-2" } }, selector)).toBe("session-2");
        expect(readRestrictedCredentialRouteField({ query: { sessionId: "session-1", sessionAccessSessionId: "session-2" } }, selector)).toBeUndefined();
        expect(readRestrictedCredentialRouteField({ query: {} }, selector)).toBeUndefined();
    });
    it("refuses a restricted token on an ordinary API-token opt-in", () => {
        const request = { authTokenKind: "api_token", apiTokenPrincipal: principal,
            routeOptions: { config: { allowApiToken: true } } };
        expect(isRestrictedAuthTokenDeniedForRoute(request)).toBe(true);
    });

    it("admits explicit scoped surfaces and Session-action surfaces", () => {
        const scopedRequest = { authTokenKind: "api_token", apiTokenPrincipal: principal,
            routeOptions: { config: { allowApiToken: true, allowScopedApiToken: true } } };
        expect(isRestrictedAuthTokenDeniedForRoute(scopedRequest)).toBe(false);
        const sessionRequest = { authTokenKind: "api_token", apiTokenPrincipal: principal,
            params: { sessionId: "session-1" }, routeOptions: { config: {
                apiTokenSessionAction: "session.message.send",
                restrictedCredentialBinding: { scope: "session" as const, session: "params.sessionId" as const },
            } } };
        expect(isRestrictedAuthTokenDeniedForRoute(sessionRequest)).toBe(false);
    });

    it("retains the existing unrestricted bearer opt-in", () => {
        const unrestricted = { ...principal, grant: { ...principal.grant, actions: null, targets: null } };
        const request = { authTokenKind: "api_token", apiTokenPrincipal: unrestricted,
            routeOptions: { config: { allowApiToken: true } } };
        expect(isRestrictedAuthTokenDeniedForRoute(request)).toBe(false);
    });

    it('keeps every declared Session operand inside a Runner principal', () => {
        const runner = VerifiedEphemeralSessionRunnerPrincipalSchema.parse({
            kind: 'ephemeral_session_runner', authority: 'session_runtime', accountId: 'account-1',
            activationId: '00000000-0000-4000-8000-000000000001', sessionId: 'session-1', machineId: 'machine-1',
            installationId: 'installation-1', installationPublicKey: Buffer.alloc(32, 1).toString('base64url'), creatorTokenEpoch: 0,
        });
        const request = { authTokenKind: 'ephemeral_session_runner', userId: runner.accountId, sessionRuntimePrincipal: runner,
            params: { destinationSessionId: runner.sessionId, sourceSessionId: 'session-2' },
            routeOptions: { config: { restrictedCredentialBinding: { scope: 'session', session: 'params.destinationSessionId',
                additionalSessions: ['params.sourceSessionId'] } } } } as const;
        expect(isRestrictedAuthTokenDeniedForRoute(request)).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({ ...request, params: {
            destinationSessionId: runner.sessionId, sourceSessionId: runner.sessionId,
        } })).toBe(false);
        for (const [operand, field] of [
            ['managerSessionId', 'body.managerSessionId'], ['expectedManagerSessionId', 'body.expectedManagerSessionId'],
        ] as const) {
            const nullableRequest = { ...request, body: { [operand]: null }, routeOptions: { config: {
                restrictedCredentialBinding: { scope: 'session', session: 'params.destinationSessionId',
                    additionalSessions: [{ field, nullable: true }] },
            } } } as const;
            expect(isRestrictedAuthTokenDeniedForRoute(nullableRequest)).toBe(false);
            expect(isRestrictedAuthTokenDeniedForRoute({ ...nullableRequest, body: { [operand]: runner.sessionId } })).toBe(false);
            expect(isRestrictedAuthTokenDeniedForRoute({ ...nullableRequest, body: { [operand]: 'session-2' } })).toBe(true);
            expect(isRestrictedAuthTokenDeniedForRoute({ ...nullableRequest, body: {} })).toBe(true);
        }
        expect(isRestrictedAuthTokenDeniedForRoute({ ...request, params: { destinationSessionId: runner.sessionId } })).toBe(true);
        expect(isRestrictedAuthTokenDeniedForRoute({ ...request, params: {
            destinationSessionId: runner.sessionId, sourceSessionId: runner.sessionId,
        }, routeOptions: { config: { restrictedCredentialBinding: {
            ...request.routeOptions.config.restrictedCredentialBinding, allowSessionRuntime: false,
        } } } })).toBe(true);
    });

    it('retains the captured PAT ceiling until signed Session resource admission is proved', () => {
        const request = { authAuthority: 'account_automation' as const, apiTokenPrincipal: principal,
            externalActionExecutionAuthorized: true, externalActionInputConstraints: {
                models: principal.grant.models, permissionModes: principal.grant.permissionModes,
            } };
        expect(readSessionAccessAuthenticationFromRequest(request).apiTokenGrant).toEqual(principal.grant);
        const admitted = { ...request, externalActionSessionAccessAdmitted: true };
        expect(readSessionAccessAuthenticationFromRequest(admitted).apiTokenGrant).toBeUndefined();
        expect(readSessionAccessAuthenticationFromRequest(admitted).callerInputConstraints).toEqual(request.externalActionInputConstraints);
    });
});
