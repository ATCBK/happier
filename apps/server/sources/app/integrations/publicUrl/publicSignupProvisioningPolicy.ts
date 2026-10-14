import type { FeaturesResponse } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { classifyRequestIp, type RequestIpClassification } from "@/app/net/requestOrigin";
import { deriveLegacySignupMethodsFromAuthMethods } from '@/app/features/authFeature';
import type { AuthMethodActionMode } from '@/app/auth/methods/types';

export type PublicProvisioningActionMode = "keyed" | "keyless";

type PublicSignupProvisioningDenyConfig = Readonly<{
    methodIds: ReadonlySet<string>;
    modes: ReadonlySet<PublicProvisioningActionMode>;
    ipClasses: ReadonlySet<RequestIpClassification>;
}>;

function parseCsvList(raw: string | undefined): string[] {
    if (typeof raw !== "string") return [];
    return raw
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
}

function normalizeMethodId(raw: string): string {
    return raw.trim().toLowerCase();
}

function normalizeMode(raw: string): PublicProvisioningActionMode | null {
    const value = raw.trim().toLowerCase();
    if (value === "keyed" || value === "keyless") return value;
    return null;
}

function normalizeIpClass(raw: string): RequestIpClassification | null {
    const value = raw.trim().toLowerCase();
    if (value === "public" || value === "private" || value === "unknown") return value;
    return null;
}

function readPublicSignupProvisioningDenyConfigFromEnv(env: NodeJS.ProcessEnv): PublicSignupProvisioningDenyConfig | null {
    const rawMethods = parseCsvList(env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS).map(normalizeMethodId).filter(Boolean);
    const methodIds = new Set(rawMethods);
    if (methodIds.size === 0) return null;

    const rawModes = parseCsvList(env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES);
    const normalizedModes = rawModes.includes("*")
        ? (["keyed", "keyless"] as PublicProvisioningActionMode[])
        : rawModes.map(normalizeMode).filter((mode): mode is PublicProvisioningActionMode => Boolean(mode));
    const modes = new Set<PublicProvisioningActionMode>(normalizedModes.length > 0 ? normalizedModes : ["keyed", "keyless"]);

    const rawIpClasses = parseCsvList(env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_IP_CLASSES);
    const ipClassRaw = rawIpClasses.includes("*")
        ? (["public", "private", "unknown"] as RequestIpClassification[])
        : rawIpClasses.map(normalizeIpClass).filter((ipClass): ipClass is RequestIpClassification => Boolean(ipClass));
    const ipClasses = new Set<RequestIpClassification>(ipClassRaw.length > 0 ? ipClassRaw : ["public", "unknown"]);

    return {
        methodIds,
        modes,
        ipClasses,
    };
}

function isDeniedActionMode(modes: ReadonlySet<PublicProvisioningActionMode>, mode: string): boolean {
    const value = mode.trim().toLowerCase();
    if (value === "either") return modes.has("keyed") && modes.has("keyless");
    const normalized = normalizeMode(value);
    return Boolean(normalized && modes.has(normalized));
}

function isDeniedRequestIpClassAllowed(ipClasses: ReadonlySet<RequestIpClassification>, requestIp: unknown): boolean {
    const classification = classifyRequestIp(requestIp);
    return ipClasses.has(classification);
}

export function shouldDenyPublicSignupProvisioningAction(params: Readonly<{
    env: NodeJS.ProcessEnv;
    requestIp: unknown;
    methodId: string;
    mode: string;
}>): boolean {
    const config = readPublicSignupProvisioningDenyConfigFromEnv(params.env);
    if (!config) return false;

    const normalizedMethodId = normalizeMethodId(params.methodId);
    if (!config.methodIds.has("*") && !config.methodIds.has(normalizedMethodId)) return false;
    if (!isDeniedActionMode(config.modes, params.mode)) return false;
    if (!isDeniedRequestIpClassAllowed(config.ipClasses, params.requestIp)) return false;

    return true;
}

/** Project exactly the branches that the same final-admission predicate permits. */
export function resolvePublicSignupProvisioningActionMode(params: Readonly<{
    env: NodeJS.ProcessEnv;
    requestIp: unknown;
    methodId: string;
    mode: AuthMethodActionMode;
}>): AuthMethodActionMode | null {
    if (params.mode !== "either") {
        return shouldDenyPublicSignupProvisioningAction(params) ? null : params.mode;
    }
    const keyed = !shouldDenyPublicSignupProvisioningAction({ ...params, mode: "keyed" });
    const keyless = !shouldDenyPublicSignupProvisioningAction({ ...params, mode: "keyless" });
    return keyed && keyless ? "either" : keyed ? "keyed" : keyless ? "keyless" : null;
}

export function applyPublicSignupProvisioningRestrictionsToFeaturesPayload(params: Readonly<{
    payload: FeaturesResponse;
    env: NodeJS.ProcessEnv;
    requestIp: unknown;
}>): FeaturesResponse {
    const auth = params.payload.capabilities.auth;
    const methods = auth?.methods ?? [];
    if (!Array.isArray(methods) || methods.length === 0) return params.payload;

    const config = readPublicSignupProvisioningDenyConfigFromEnv(params.env);
    if (!config) return params.payload;

    const nextMethods = methods.map((method) => ({
        ...method,
        actions: Array.isArray(method.actions)
            ? method.actions.map((action) => {
                  if (String(action?.id ?? "").trim().toLowerCase() !== "provision") return action;
                  const mode = resolvePublicSignupProvisioningActionMode({
                      env: params.env,
                      requestIp: params.requestIp,
                      methodId: String(method?.id ?? ""),
                      mode: action.mode,
                  });
                  return mode === null ? { ...action, enabled: false } : { ...action, mode };
              })
            : [],
    }));

    const signup = auth.signup;
    const nextSignupMethods = deriveLegacySignupMethodsFromAuthMethods(
        nextMethods,
        auth.signup.methods.map((method) => method.id),
    );

    return {
        ...params.payload,
        capabilities: {
            ...params.payload.capabilities,
            auth: {
                ...auth,
                methods: nextMethods,
                signup: {
                    ...signup,
                    methods: nextSignupMethods,
                },
            },
        },
    };
}
