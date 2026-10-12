import type { AuthTokenAuthority, AuthTokenKind } from "@happier-dev/protocol";
import { resolveInvocationAuthority, TerminalPresentUserPolicySchema } from "@happier-dev/protocol/actions";
import type { ActionRequiredAuthority } from "@happier-dev/protocol/actions/metadata";

/** A caller can lower verified authority; no caller-supplied value can raise it. */
export function narrowCredentialAuthority(authority: ActionRequiredAuthority, ceiling: unknown): ActionRequiredAuthority;
export function narrowCredentialAuthority(authority: AuthTokenAuthority, ceiling: unknown): AuthTokenAuthority;
export function narrowCredentialAuthority(authority: AuthTokenAuthority, ceiling: unknown): AuthTokenAuthority {
    return authority === "present_user" && ceiling === "account_automation" ? "account_automation" : authority;
}

/** The signed floor stays unchanged; current Account policy governs terminal invocations. */
export function effectiveCredentialAuthority(input: Readonly<{
    credentialKind: AuthTokenKind;
    mintedAuthority: AuthTokenAuthority;
    terminalPresentUserPolicy: unknown;
}>): AuthTokenAuthority {
    if (input.credentialKind !== "terminal") return input.mintedAuthority;
    const policy = TerminalPresentUserPolicySchema.safeParse(input.terminalPresentUserPolicy);
    return resolveInvocationAuthority({
        credential: "terminal",
        surface: "rpc",
        terminalPolicy: policy.success ? policy.data : "disallowed",
    });
}
