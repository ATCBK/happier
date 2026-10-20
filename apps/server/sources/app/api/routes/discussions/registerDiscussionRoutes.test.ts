import { describe, expect, it, vi } from "vitest";

import { DISCUSSION_HTTP_PATHS_V1 } from "@happier-dev/protocol";
import { API_TOKEN_FULL_GRANT_V1 } from "@happier-dev/protocol/auth/apiTokenGrant";

import { isRestrictedAuthTokenDeniedForRoute } from "@/app/api/utils/apiTokenRouteAdmission";
import { requireRouteActionAuthority } from "@/app/api/utils/requireRouteActionAuthority";
import { createFakeRouteApp, getRouteEntry } from "../../testkit/routeHarness";
import { registerSessionReadStateRoutes } from "../session/registerSessionReadStateRoutes";
import { registerDiscussionRoutes } from "./registerDiscussionRoutes";

type AdmissionRouteConfig = NonNullable<
    Parameters<typeof isRestrictedAuthTokenDeniedForRoute>[0]["routeOptions"]
>["config"];

const runnerPrincipal = {
    kind: "ephemeral_session_runner",
    authority: "session_runtime",
    accountId: "account-1",
    activationId: "activation-1",
    sessionId: "session-1",
    machineId: "machine-1",
    installationId: "installation-1",
    installationPublicKey: "public-key-1",
    creatorTokenEpoch: 0,
} as never;

function registeredDiscussionRouteConfigs() {
    const app = createFakeRouteApp();
    registerDiscussionRoutes(app as never);
    return new Map(Array.from(app.routes, ([key, entry]) => [key, entry.opts.config as AdmissionRouteConfig]));
}

function registeredMutationGuard(
    register: typeof registerDiscussionRoutes,
    method: Parameters<typeof getRouteEntry>[1],
    path: string,
) {
    const app = createFakeRouteApp();
    register(app as never);
    const preHandlers = getRouteEntry(app, method, path).opts.preHandler;
    return Array.isArray(preHandlers)
        ? preHandlers.at(-1) as ReturnType<typeof requireRouteActionAuthority> | undefined
        : undefined;
}

describe("Discussion and Session read-state Action authority", () => {
    it("does not treat a Session-bound Runner credential as a Discussion grant", () => {
        const configs = registeredDiscussionRouteConfigs();
        for (const key of [
            `GET ${DISCUSSION_HTTP_PATHS_V1.collection}`,
            `GET ${DISCUSSION_HTTP_PATHS_V1.discussion}`,
            `GET ${DISCUSSION_HTTP_PATHS_V1.messages}`,
            `POST ${DISCUSSION_HTTP_PATHS_V1.messages}`,
        ]) {
            const config = configs.get(key);
            expect(config, key).toBeDefined();
            expect(isRestrictedAuthTokenDeniedForRoute({
                authTokenKind: "ephemeral_session_runner",
                userId: "account-1",
                sessionRuntimePrincipal: runnerPrincipal,
                params: { sessionId: "session-1" },
                routeOptions: { config },
            }), key).toBe(true);
            expect(isRestrictedAuthTokenDeniedForRoute({
                authTokenKind: "ephemeral_session_runner",
                userId: "account-1",
                sessionRuntimePrincipal: runnerPrincipal,
                params: { sessionId: "session-2" },
                routeOptions: { config },
            }), key).toBe(true);
        }
    });

    // Declassification admits verified external effects, not the Runner
    // runtime or a raw PAT on these direct mutation routes.
    it("leaves other discussion mutations outside the Runner and raw-PAT surfaces", () => {
        const configs = registeredDiscussionRouteConfigs();
        for (const key of [
            `POST ${DISCUSSION_HTTP_PATHS_V1.collection}`,
            `PATCH ${DISCUSSION_HTTP_PATHS_V1.discussion}`,
            `POST ${DISCUSSION_HTTP_PATHS_V1.archive}`,
            `POST ${DISCUSSION_HTTP_PATHS_V1.restore}`,
            `PUT ${DISCUSSION_HTTP_PATHS_V1.read}`,
        ]) {
            const config = configs.get(key);
            expect(config?.restrictedCredentialBinding, key).toBeUndefined();
            expect(isRestrictedAuthTokenDeniedForRoute({
                authTokenKind: "api_token",
                params: { sessionId: "session-1" },
                routeOptions: { config },
            }), key).toBe(true);
        }
    });

    it("requires a resource admission path for a Runner rather than trusting Session identity", async () => {
        const reply = { code: vi.fn(() => ({ send: vi.fn(() => "refused") })) };
        await expect(requireRouteActionAuthority("discussion.post")({
            authAuthority: "account_automation",
            authTokenKind: "ephemeral_session_runner",
            params: { sessionId: "session-1" },
        } as never, reply as never)).resolves.toBe("refused");
        expect(reply.code).toHaveBeenCalledWith(403);

        await expect(requireRouteActionAuthority("discussion.post")({
            authAuthority: "account_automation",
            authTokenKind: "api_token",
            params: { sessionId: "session-1" },
        } as never, reply as never)).resolves.toBe("refused");
        expect(reply.code).toHaveBeenCalledWith(403);
    });

    it("admits a terminal present user without treating Session execution metadata as Discussion authority", async () => {
        const reply = { code: vi.fn(() => ({ send: vi.fn(() => "refused") })) };
        await expect(requireRouteActionAuthority("discussion.post")({
            authAuthority: "present_user", authTokenKind: "terminal", params: { discussionId: "discussion-1" },
        } as never, reply as never)).resolves.toBeUndefined();
        await expect(requireRouteActionAuthority("discussion.post")({
            authAuthority: "account_automation", authTokenKind: "api_token", params: { discussionId: "discussion-1" },
            externalActionExecutionAuthorized: true, externalActionEffectActionId: "discussion.post",
            externalActionExecutionTarget: { kind: "session", sessionId: "session-1" },
        } as never, reply as never)).resolves.toBe("refused");
    });

    it("binds read-state writes to the verified effect and refuses terminal automation", async () => {
        const guard = registeredMutationGuard(registerSessionReadStateRoutes, "POST", "/v2/sessions/:sessionId/read-state");
        expect(guard).toBeDefined();
        const reply = { code: vi.fn(() => ({ send: vi.fn(() => "refused") })) };
        await expect(guard!({
            authAuthority: "account_automation", authTokenKind: "api_token", params: { sessionId: "session-1" },
            externalActionExecutionAuthorized: true, externalActionEffectActionId: "session.read_state.set",
            externalActionExecutionTarget: { kind: "session", sessionId: "session-1" },
        } as never, reply as never)).resolves.toBeUndefined();
        await expect(guard!({
            authAuthority: "account_automation", authTokenKind: "terminal", params: { sessionId: "session-1" },
        } as never, reply as never)).resolves.toBe("refused");
    });

    it("keeps present-user security Actions closed even for a verified approve token", async () => {
        const reply = { code: vi.fn(() => ({ send: vi.fn(() => "refused") })) };
        await expect(requireRouteActionAuthority("account.apiTokens.create")({
            authAuthority: "account_automation",
            authTokenKind: "api_token",
            apiTokenPrincipal: {
                accountId: "account-1", principalId: "principal-1", credentialId: "credential-1",
                authority: "account_automation", expiresAt: null, parentTokenId: null, embedConfig: null,
                grant: { ...API_TOKEN_FULL_GRANT_V1, approve: true },
            },
            params: { sessionId: "session-1" },
            externalActionExecutionAuthorized: true,
            externalActionEffectActionId: "account.apiTokens.create",
            externalActionExecutionTarget: { kind: "session", sessionId: "session-1" },
        }, reply as never)).resolves.toBe("refused");
        expect(reply.code).toHaveBeenCalledWith(403);
    });
});
