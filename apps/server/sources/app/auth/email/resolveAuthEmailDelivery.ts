import { resolveAuthEmailSmtpConfig } from './authEmailSmtpConfig';
export { resolveAuthEmailSmtpConfig } from './authEmailSmtpConfig';

import {
    createDisabledAuthEmailDelivery,
    createSmtpAuthEmailDelivery,
    type AuthEmailSmtpConfig,
    type AuthEmailSmtpTransport,
} from "./authEmailAdapters";
import { readHomeEffectiveEnv, type HomeConfigSource } from "@/app/features/catalog/serverFeatureGate";

import type { AuthEmailDelivery } from "./authEmailDelivery";
import { createProductionAuthEmailSmtpTransport } from "./smtpAuthEmailTransport";
import { isAuthEmailApplicationLinkBuildable, type ResolveAuthEmailApplicationLinkTarget } from "./nativeAuthEmailOperations";

/**
 * SMTP is the only configurable V1 transport. A deployment that has not
 * configured a host is unconfigured, not broken: mail-dependent operations
 * report unavailability while every other authentication journey continues.
 */
export type AuthEmailSmtpTransportFactory = (config: AuthEmailSmtpConfig) => AuthEmailSmtpTransport;

export function resolveAuthEmailDelivery(
    env: Record<string, string | undefined>,
    deps?: Readonly<{ createSmtpTransport?: AuthEmailSmtpTransportFactory }>,
): AuthEmailDelivery {
    const config = resolveAuthEmailSmtpConfig(env);
    if (!config) return createDisabledAuthEmailDelivery();
    const createSmtpTransport = deps?.createSmtpTransport ?? createProductionAuthEmailSmtpTransport;
    return createSmtpAuthEmailDelivery({ config, transport: createSmtpTransport(config) });
}

/**
 * A delivery that resolves its configuration at every use instead of once: the SMTP settings in
 * force when a message is sent are the ones it goes out with. The composition passes the Home's
 * effective configuration (`homeAuthEmailDelivery.ts`); nodemailer transports are cheap to build,
 * so no transport is cached across sends.
 */
export function createPerSendAuthEmailDelivery(deps: Readonly<{
    readEnv: () => Promise<Record<string, string | undefined>>;
    createSmtpTransport?: AuthEmailSmtpTransportFactory;
}>): AuthEmailDelivery {
    const transportDeps = deps.createSmtpTransport ? { createSmtpTransport: deps.createSmtpTransport } : undefined;
    return {
        async isReady() {
            return isAuthEmailTransportConfigured(await deps.readEnv());
        },
        async deliver(message) {
            return await resolveAuthEmailDelivery(await deps.readEnv(), transportDeps).deliver(message);
        },
    };
}

/** Whether an SMTP transport is configured. A transport alone is not mail readiness. */
export function isAuthEmailTransportConfigured(
    env: Record<string, string | undefined>,
): boolean {
    return resolveAuthEmailSmtpConfig(env) !== null;
}

/**
 * The one mail-readiness answer. Mail-dependent actions (account creation by email, password reset,
 * sign-in email change, mailed invitations) are ready only when mail can be sent **and** the link it
 * must carry can be built from the same facts the send path renders it from. It is Home-wide, never
 * per address, so existence-neutral request routes keep answering identically. A failing link-target
 * read is "not ready", never an error.
 */
export async function resolveAuthEmailReadiness(input: Readonly<{
    transportReady: boolean;
    resolveApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget | null;
}>): Promise<boolean> {
    if (!input.transportReady || !input.resolveApplicationLinkTarget) return false;
    try {
        return isAuthEmailApplicationLinkBuildable(await input.resolveApplicationLinkTarget());
    } catch {
        return false;
    }
}

/**
 * Startup-registered link-target owner for callers that only hold the process environment (feature
 * projection, Home governance). The API composition registers the same resolver its mail routes use.
 */
let processApplicationLinkTarget: ResolveAuthEmailApplicationLinkTarget | null = null;

export function registerAuthEmailApplicationLinkTarget(resolver: ResolveAuthEmailApplicationLinkTarget | null): void {
    processApplicationLinkTarget = resolver;
}

/**
 * The facts behind readiness, for the Home owner's Email page: whether a transport is configured,
 * whether the link a mail must carry can be built, and the readiness they make together. The same
 * rule as `resolveAuthEmailReadiness`, split so the console can say which half is missing.
 */
export async function readAuthEmailReadinessFacts(
    env: Record<string, string | undefined>,
): Promise<Readonly<{ transportConfigured: boolean; linkTargetBuildable: boolean; linkOrigin: string | null; ready: boolean }>> {
    const transportConfigured = isAuthEmailTransportConfigured(env);
    const target = processApplicationLinkTarget ? await processApplicationLinkTarget(env).catch(() => null) : null;
    const linkTargetBuildable = target !== null && isAuthEmailApplicationLinkBuildable(target);
    return {
        transportConfigured,
        linkTargetBuildable,
        linkOrigin: target?.applicationOrigin ?? null,
        ready: transportConfigured && linkTargetBuildable,
    };
}

/**
 * Process-wide mail readiness from the environment's transport and the registered link target.
 * Consumed by method readiness so the product can explain which mail-dependent operations are
 * unavailable rather than failing them, or silently sending nothing, at submit time.
 */
export async function isAuthEmailDeliveryReady(source: Omit<HomeConfigSource, "tx">): Promise<boolean> {
    // Prepare this fact before opening a transaction: the registered link-target
    // owner can await descriptor publication, native endpoint state and continuity IO.
    // Transaction owners consume the boolean alongside their Home-effective configuration.
    const env = await readHomeEffectiveEnv(source);
    const resolver = processApplicationLinkTarget;
    return await resolveAuthEmailReadiness({
        transportReady: isAuthEmailTransportConfigured(env),
        resolveApplicationLinkTarget: resolver ? async () => await resolver(env) : null,
    });
}
