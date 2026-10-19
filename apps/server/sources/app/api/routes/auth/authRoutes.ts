import { type Fastify } from "../../types";
import { registerTerminalAuthRequestRoutes } from "./registerTerminalAuthRequestRoutes";
import { registerAccountAuthRoutes } from "./registerAccountAuthRoutes";
import { registerPairingAuthRoutes } from "./registerPairingAuthRoutes";
import { registerApiTokenIntrospectionRoute } from "./registerApiTokenIntrospectionRoute";
import { registerAccountApiTokenManagementRoutes } from "./registerAccountApiTokenManagementRoutes";
import { registerAccountSessionsSignOutEverywhereRoute } from "./registerAccountSessionsSignOutEverywhereRoute";
import { registerAccountErasureRoute } from "./registerAccountErasureRoute";
import { resolveTerminalAuthRequestPolicyFromEnv, terminalAuthRequestExpiresAt } from "./terminalAuthRequestPolicy";
import { resolveEffectiveHomeAuthMethods } from "@/app/auth/methods/effectiveHomeAuthMethods";
import { resolveAuthMethodRegistry } from "@/app/auth/methods/registry";
import { z } from "zod/mini";
import { registerHomeLoginRoute } from "@/app/accountDirectory/accountDirectoryRoutes";
import type { HomeConnectionDescriptorResolver } from "@/app/accountDirectory/accountDirectoryService";
import { registerHomeLoginApprovalRoutes } from "./homeApprovalGate";
import { registerAuthEntryRoute } from "./registerAuthEntryRoute";
import { resolveAuthEmailReadiness } from "@/app/auth/email/resolveAuthEmailDelivery";
import { createHomeAuthEmailDelivery } from "@/app/auth/email/homeAuthEmailDelivery";
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import type { ResolveAuthEmailApplicationLinkTarget } from "@/app/auth/email/nativeAuthEmailOperations";

export function authRoutes(app: Fastify, params: Readonly<{
    resolveHomeConnectionDescriptor?: HomeConnectionDescriptorResolver;
    isEmailDeliveryReady?: () => boolean | Promise<boolean>;
    authEmailDelivery?: AuthEmailDelivery;
    resolveApplicationLinkTarget?: ResolveAuthEmailApplicationLinkTarget;
}> = {}): void {
    const authEmailDelivery = params.authEmailDelivery ?? createHomeAuthEmailDelivery();
    const resolveApplicationLinkTarget = params.resolveApplicationLinkTarget
        ?? (async () => ({ applicationOrigin: null, homeTarget: null, serverId: null }));
    // One readiness owner: mail can be sent and its link can be built from these same facts.
    const isEmailDeliveryReady = params.isEmailDeliveryReady
        ?? (async () => await resolveAuthEmailReadiness({ transportReady: await authEmailDelivery.isReady(), resolveApplicationLinkTarget }));
    app.get(
        "/v1/auth/ping",
        {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: z.object({ ok: z.literal(true) }),
                },
            },
        },
        async (_request, reply) => {
            return reply.send({ ok: true });
        },
    );

    registerAuthEntryRoute(app, { isEmailDeliveryReady });

    registerApiTokenIntrospectionRoute(app);
    registerAccountApiTokenManagementRoutes(app);
    registerAccountSessionsSignOutEverywhereRoute(app);
    registerAccountErasureRoute(app);

    const terminalAuthPolicy = resolveTerminalAuthRequestPolicyFromEnv(process.env);
    const isTerminalAuthExpired = (createdAt: Date): boolean => {
        return Date.now() > terminalAuthRequestExpiresAt(createdAt, terminalAuthPolicy);
    };

    app.addHook("onReady", async () => {
        const methods = await resolveEffectiveHomeAuthMethods({
            env: process.env,
            emailDeliveryReady: await isEmailDeliveryReady(),
        });
        if (methods.status !== "ready" || !methods.decisions.some((method) =>
            method.actions.some((action) => action.enabled && (action.id === "login" || action.id === "provision")))) {
            throw new Error("No login methods are available under the effective Home authentication policy.");
        }
    });
    const authMethodRegistry = resolveAuthMethodRegistry(process.env);
    for (const method of authMethodRegistry) {
        method.registerRoutes(app, { isEmailDeliveryReady, authEmailDelivery, resolveApplicationLinkTarget });
    }
    registerTerminalAuthRequestRoutes(app, { terminalAuthPolicy, isTerminalAuthExpired });
    registerAccountAuthRoutes(app);
    registerPairingAuthRoutes(app);
    registerHomeLoginApprovalRoutes(app);
    registerHomeLoginRoute(app, {
        ...(params.resolveHomeConnectionDescriptor
            ? { resolveHomeConnectionDescriptor: params.resolveHomeConnectionDescriptor }
            : {}),
    });
}
