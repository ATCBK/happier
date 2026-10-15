import {
    TeamDirectoryErrorV1Schema,
    TeamDirectoryGroupPageV1Schema,
    TeamDirectoryGroupsListQueryV1Schema,
    TeamDirectoryLifecycleBodyV1Schema,
    TeamDirectoryPeopleListQueryV1Schema,
    TeamDirectoryPeoplePageV1Schema,
    TeamDirectorySafeErrorCodeV1Schema,
    TeamDirectorySourceCreateBodyV1Schema,
    TeamDirectorySourcePageV1Schema,
    TeamDirectorySourceSetupListQueryV1Schema,
    TeamDirectorySourceSetupOptionsV1Schema,
    TeamDirectorySourceParamsV1Schema,
    TeamDirectorySourceRemovalPreflightV1Schema,
    TeamDirectorySourceRemoveResultV1Schema,
    TeamDirectorySourceSummaryV1Schema,
    TeamDirectorySourceSyncResultV1Schema,
    TeamDirectorySourceListQueryV1Schema,
    TeamDirectoryTeamParamsV1Schema,
    TeamExternalGroupBindingParamsV1Schema,
    TeamExternalGroupBindingRemoveResultV1Schema,
    TeamExternalGroupBindingSetBodyV1Schema,
    TeamExternalGroupBindingTeamParamsV1Schema,
    TeamExternalGroupBindingV1Schema,
    TeamExternalGroupBindingsListQueryV1Schema,
    TeamExternalGroupBindingsPageV1Schema,
    TeamErrorCodeV1Schema,
    TeamErrorV1Schema,
    TeamIdentityErrorV1Schema,
    teamErrorHttpStatusV1,
    teamIdentityErrorHttpStatusV1,
    type TeamDirectorySafeErrorCodeV1,
    type TeamDirectoryErrorV1,
    type TeamErrorCodeV1,
    type TeamErrorV1,
    type TeamIdentityErrorCodeV1,
} from "@happier-dev/protocol/teams";
import { TEAM_DIRECTORY_ACTION_PATHS_V1, TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1 } from '@happier-dev/protocol/teams';
import { z } from "zod/mini";

import type { Fastify } from "@/app/api/types";
import { readTeamOperationAuthenticationFromRequest } from "../actorContext";
import { createTeamRouteApp } from "../teamRouteApp";
import {
    createDirectorySourceForActor,
    getDirectorySourceForActor,
    listDirectoryGroupsForActor,
    listDirectoryPeopleForActor,
    listDirectorySourcesForActor,
    listDirectorySourceSetupOptionsForActor,
    preflightDirectorySourceRemovalForActor,
    removeDirectorySourceForActor,
    setDirectorySourcePausedForActor,
    syncDirectorySourceForActor,
} from "./directorySourceAdministration";
import {
    listExternalGroupBindingsForActor,
    removeExternalGroupBindingForActor,
    setExternalGroupBindingForActor,
} from "./externalGroupBindingAdministration";

// `team_identity_not_allowed` is the Home provider-kind refusal the identity
// routes already return for the same Home policy fact.
const DirectoryRouteErrorV1Schema = z.union([TeamDirectoryErrorV1Schema, TeamErrorV1Schema, TeamIdentityErrorV1Schema]);
const DirectoryErrors = {
    400: DirectoryRouteErrorV1Schema,
    403: DirectoryRouteErrorV1Schema,
    404: DirectoryRouteErrorV1Schema,
    409: DirectoryRouteErrorV1Schema,
    503: DirectoryRouteErrorV1Schema,
} as const;

type DirectoryRouteError = TeamErrorCodeV1 | TeamDirectorySafeErrorCodeV1 | "team_identity_not_allowed";
type DirectoryErrorReply = {
    code: (status: 400 | 403 | 404 | 409 | 503) => {
        send: (payload: TeamErrorV1 | TeamDirectoryErrorV1 | Readonly<{ error: TeamIdentityErrorCodeV1 }>) => void;
    };
};

function directoryErrorHttpStatus(error: DirectoryRouteError): 400 | 403 | 404 | 409 | 503 {
    if (error === "team_identity_not_allowed") return teamIdentityErrorHttpStatusV1(error);
    const teamError = TeamErrorCodeV1Schema.safeParse(error);
    if (teamError.success) return teamErrorHttpStatusV1(teamError.data);
    const directoryError = TeamDirectorySafeErrorCodeV1Schema.parse(error);
    switch (directoryError) {
        case "directory_sync_unavailable":
        case "directory_sync_rate_limited":
            return 503;
        case "directory_source_not_found":
            return 404;
        case "directory_group_mapping_invalid":
            return 400;
        case "directory_source_removed":
        case "directory_source_identity_mismatch":
        case "directory_source_permission_lost":
        case "directory_cursor_expired":
        case "directory_event_invalid":
        case "directory_snapshot_incomplete":
        case "directory_group_already_bound":
        case "directory_sync_needs_attention":
            return 409;
    }
}

function fail(reply: DirectoryErrorReply, error: DirectoryRouteError): void {
    if (error === "team_identity_not_allowed") {
        reply.code(directoryErrorHttpStatus(error)).send({ error });
        return;
    }
    const teamError = TeamErrorCodeV1Schema.safeParse(error);
    if (teamError.success) {
        reply.code(directoryErrorHttpStatus(error)).send({ error: teamError.data });
        return;
    }
    reply.code(directoryErrorHttpStatus(error)).send({
        error: TeamDirectorySafeErrorCodeV1Schema.parse(error),
    });
}

/** Register the single REST adapter for Team directory source Actions. */
export function registerTeamDirectoryRoutes(app: Fastify): void {
    const teamsApp = createTeamRouteApp(app);

    teamsApp.get(TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1["teams.externalGroupBindings.list"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamExternalGroupBindingTeamParamsV1Schema,
            querystring: TeamExternalGroupBindingsListQueryV1Schema,
            response: { 200: TeamExternalGroupBindingsPageV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await listExternalGroupBindingsForActor({
            v: 1,
            teamId: request.params.teamId,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
            ...request.query,
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.put(TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1["teams.externalGroupBindings.set"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamExternalGroupBindingTeamParamsV1Schema,
            body: TeamExternalGroupBindingSetBodyV1Schema,
            response: { 200: TeamExternalGroupBindingV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await setExternalGroupBindingForActor({
            ...request.body,
            teamId: request.params.teamId,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.delete(TEAM_EXTERNAL_GROUP_BINDING_ACTION_PATHS_V1["teams.externalGroupBindings.remove"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamExternalGroupBindingParamsV1Schema,
            body: TeamDirectoryLifecycleBodyV1Schema,
            response: { 200: TeamExternalGroupBindingRemoveResultV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await removeExternalGroupBindingForActor({
            v: request.body.v,
            ...request.params,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.list"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectoryTeamParamsV1Schema,
            querystring: TeamDirectorySourceListQueryV1Schema,
            response: { 200: TeamDirectorySourcePageV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await listDirectorySourcesForActor({
            v: 1,
            teamId: request.params.teamId,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
            ...request.query,
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sourceSetup.list"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectoryTeamParamsV1Schema,
            querystring: TeamDirectorySourceSetupListQueryV1Schema,
            response: { 200: TeamDirectorySourceSetupOptionsV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await listDirectorySourceSetupOptionsForActor({
            v: 1,
            teamId: request.params.teamId,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
            ...request.query,
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.create"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectoryTeamParamsV1Schema,
            body: TeamDirectorySourceCreateBodyV1Schema,
            response: { 200: TeamDirectorySourceSummaryV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await createDirectorySourceForActor({
            ...request.body,
            teamId: request.params.teamId,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.get"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            response: { 200: TeamDirectorySourceSummaryV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await getDirectorySourceForActor({
            ...request.params,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.people.list"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            querystring: TeamDirectoryPeopleListQueryV1Schema,
            response: { 200: TeamDirectoryPeoplePageV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await listDirectoryPeopleForActor({
            v: 1,
            ...request.params,
            ...request.query,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.groups.list"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            querystring: TeamDirectoryGroupsListQueryV1Schema,
            response: { 200: TeamDirectoryGroupPageV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await listDirectoryGroupsForActor({
            v: 1,
            ...request.params,
            ...request.query,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.post(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.sync"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            body: TeamDirectoryLifecycleBodyV1Schema,
            response: { 202: TeamDirectorySourceSyncResultV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await syncDirectorySourceForActor({
            ...request.params,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.code(202).send(result.value);
    });

    const registerPauseRoute = (path: string, paused: boolean) => {
        teamsApp.post(path, {
            preHandler: app.authenticate,
            schema: {
                params: TeamDirectorySourceParamsV1Schema,
                body: TeamDirectoryLifecycleBodyV1Schema,
                response: { 200: TeamDirectorySourceSummaryV1Schema, ...DirectoryErrors },
            },
        }, async (request, reply) => {
            const result = await setDirectorySourcePausedForActor({
                ...request.params,
                actorAccountId: request.userId,
                ...readTeamOperationAuthenticationFromRequest(request),
                paused,
            });
            if (!result.ok) return fail(reply, result.error);
            return reply.send(result.value);
        });
    };
    registerPauseRoute(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.pause"], true);
    registerPauseRoute(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.resume"], false);

    teamsApp.get(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.remove.preview"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            response: { 200: TeamDirectorySourceRemovalPreflightV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await preflightDirectorySourceRemovalForActor({
            ...request.params,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });

    teamsApp.delete(TEAM_DIRECTORY_ACTION_PATHS_V1["teams.directory.sources.remove"], {
        preHandler: app.authenticate,
        schema: {
            params: TeamDirectorySourceParamsV1Schema,
            body: TeamDirectoryLifecycleBodyV1Schema,
            response: { 200: TeamDirectorySourceRemoveResultV1Schema, ...DirectoryErrors },
        },
    }, async (request, reply) => {
        const result = await removeDirectorySourceForActor({
            ...request.params,
            actorAccountId: request.userId,
            ...readTeamOperationAuthenticationFromRequest(request),
        });
        if (!result.ok) return fail(reply, result.error);
        return reply.send(result.value);
    });
}
