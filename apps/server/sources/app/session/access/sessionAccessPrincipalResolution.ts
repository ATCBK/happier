import type { ResolveSessionAccessPrincipalsResponseV1 } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { projectAccountDisplayProfileV1, ACCOUNT_DISPLAY_PROFILE_SELECT } from "@/app/account/profile/accountDisplayProfile";
import { buildSessionAccessCollaborationAccountWhere } from "./sessionAccessGrantEligibility";
import { resolveGrantableTeamForActorInTx } from "@/app/teams/queries";
import { resolveGrantableTeamGroupForActorInTx } from "@/app/teams/groups/groupService";
import {
    qualifyTeamProjectionReadAuthenticationsInTx,
    resolveTeamActorContextsInTx,
} from "@/app/teams/actorContext";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";
import type { Tx } from "@/storage/inTx";
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';

/** Resolve only the explicitly requested, currently discoverable principals. */
export async function resolveSessionAccessPrincipalsInTx(input: Readonly<{
    tx: Tx;
    actorAccountId: string;
    subjects: readonly PrincipalRefV1[];
    creationTeamId?: string;
    authentication?: SessionAccessAuthentication;
}>): Promise<ResolveSessionAccessPrincipalsResponseV1> {
    const subjects = [...new Map(input.subjects.map((subject) => [principalKey(subject), subject])).values()];
    const accountIds = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "account" }> => subject.kind === "account")
        .map((subject) => subject.accountId);
    const accounts = accountIds.length === 0 ? [] : await input.tx.account.findMany({
        where: { AND: [{ id: { in: accountIds } }, buildSessionAccessCollaborationAccountWhere(input.actorAccountId)] },
        select: ACCOUNT_DISPLAY_PROFILE_SELECT,
    });
    const accountsById = new Map(accounts.map((account) => [account.id, account]));

    const teamSubjects = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "team" }> => subject.kind === "team");
    const groupSubjects = subjects.filter((subject): subject is Extract<PrincipalRefV1, { kind: "group" }> => subject.kind === "group");
    const teamIds = [...new Set([
        ...teamSubjects.map((subject) => subject.teamId),
        ...groupSubjects.map((subject) => subject.teamId),
        ...(input.creationTeamId ? [input.creationTeamId] : []),
    ])];
    const contexts = await resolveTeamActorContextsInTx(input.tx, { teamIds, actorAccountId: input.actorAccountId });
    const qualifications = await qualifyTeamProjectionReadAuthenticationsInTx(input.tx, {
        contexts: [...contexts.values()],
        ...(input.authentication ? {
            env: input.authentication.env,
            authenticationEvidence: input.authentication.authenticationEvidence,
            authenticationAuthority: input.authentication.authority,
        } : {}),
    });
    const result: ResolveSessionAccessPrincipalsResponseV1["principals"] = [];
    for (const subject of subjects) {
        if (subject.kind === "account") {
            const account = accountsById.get(subject.accountId);
            if (account) result.push({ kind: "account", accountId: account.id, ...projectAccountDisplayProfileV1(account) });
            continue;
        }
        const context = contexts.get(subject.teamId);
        if (!context || !qualifications.get(subject.teamId)?.ok) continue;
        if (subject.kind === "team") {
            if (await resolveGrantableTeamForActorInTx(input.tx, { actorAccountId: input.actorAccountId, teamId: subject.teamId })) {
                result.push({ kind: "team", teamId: context.team.id, name: context.team.name });
            }
            continue;
        }
        if (await resolveGrantableTeamGroupForActorInTx(input.tx, {
            actorAccountId: input.actorAccountId, teamId: subject.teamId, groupId: subject.groupId,
        })) {
            const group = await input.tx.teamGroup.findUnique({
                where: { id: subject.groupId },
                select: { id: true, teamId: true, name: true },
            });
            if (group?.teamId === subject.teamId) {
                result.push({ kind: "group", teamId: group.teamId, groupId: group.id, name: group.name, teamName: context.team.name });
            }
        }
    }
    let creationDecision: ResolveSessionAccessPrincipalsResponseV1["creationDecision"] = null;
    if (input.creationTeamId) {
        const context = contexts.get(input.creationTeamId);
        const qualification = qualifications.get(input.creationTeamId);
        if (context && qualification?.ok && await resolveGrantableTeamForActorInTx(input.tx, {
            actorAccountId: input.actorAccountId, teamId: input.creationTeamId,
        })) {
            const policy = context.team.sessionCreationPolicy;
            creationDecision = {
                v: 1,
                teamId: context.team.id,
                teamName: context.team.name,
                requiredByPolicy: policy === "team_required",
                defaultGrant: policy === "private_default" ? null : {
                    accessLevel: "edit",
                    canApprovePermissions: false,
                },
                externalSharingPolicy: context.team.externalSharingPolicy,
            };
        }
    }
    return { v: 1, principals: result, ...(input.creationTeamId !== undefined ? { creationDecision } : {}) };
}

function principalKey(subject: PrincipalRefV1): string {
    return subject.kind === "account" ? `account:${subject.accountId}`
        : subject.kind === "team" ? `team:${subject.teamId}`
            : `group:${subject.teamId}:${subject.groupId}`;
}
