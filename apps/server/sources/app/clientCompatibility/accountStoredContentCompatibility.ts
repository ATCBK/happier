import { CLIENT_UPGRADE_REQUIRED_ERROR_CODE, CLIENT_UPGRADE_REQUIRED_HTTP_STATUS, type AccountStoredContentUpgradeRequiredV1 } from '@happier-dev/protocol/clientCompatibility/upgradeRequiredV1';
import { ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION, ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION, ACCOUNT_STORED_CONTENT_MACHINE_POOL_CHANGE_PROTOCOL_VERSION, ACCOUNT_STORED_CONTENT_SAVED_SECRET_RESOURCE_CHANGE_PROTOCOL_VERSION, ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION, ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2, parseAccountStoredContentCompatibilityHttpHeadersV1, parseAccountStoredContentCompatibilitySocketAuthV1, type AccountStoredContentCompatibilityDeclarationParseResult, type AccountStoredContentCompatibilityDeclarationV1, type AccountStoredContentCompatibilityServerRequirementsV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Socket } from 'socket.io';

export const CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS:
    AccountStoredContentCompatibilityServerRequirementsV1 = Object.freeze({
        v: 1,
        // V3 adds the closed pluginDomain projection. V4 is the current
        // cumulative declaration for the additive changes witness and the
        // profile-preserving Account Settings writer. V2 remains sufficient
        // for incumbent stored-content operations that do not require either.
        minimumProtocolVersion: ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
        currentProtocolVersion:
            ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION,
        declarationTransport: 'http-header-and-socket-auth-v1',
    });

export type AccountStoredContentCompatibilityOutcome =
    | 'accepted'
    | 'legacy-missing'
    | 'legacy-malformed'
    | 'legacy-protocol-too-old';

export interface AccountStoredContentCompatibilityEvaluation {
    readonly supportsCurrentProtocol: boolean;
    /** Whether this peer can receive the additive pluginDomain change kind. */
    readonly supportsPluginDataProtocol: boolean;
    /** Whether this peer can receive the additive Session-access witness. */
    readonly supportsSessionAccessWitnessProtocol: boolean;
    /** Whether this peer can receive the additive machinePool change kind. */
    readonly supportsMachinePoolChangeProtocol: boolean;
    /** Whether this peer can receive Saved Secret resource invalidations. */
    readonly supportsSavedSecretResourceChangeProtocol: boolean;
    readonly outcome: AccountStoredContentCompatibilityOutcome;
    readonly declaration:
        AccountStoredContentCompatibilityDeclarationV1 | null;
    readonly upgradeRequired:
        AccountStoredContentUpgradeRequiredV1 | null;
}

export interface AccountStoredContentSocketCompatibilityResult {
    readonly parseResult:
        AccountStoredContentCompatibilityDeclarationParseResult;
    readonly evaluation: AccountStoredContentCompatibilityEvaluation;
}

export function buildAccountStoredContentUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion: ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2,
        },
    };
}

/**
 * Plugin collection data is the one V3-only stored-content operation. Keeping
 * this requirement beside the shared declaration owner avoids teaching every
 * consumer to reinterpret a V2 upgrade result as V3-capable.
 */
export function buildPluginDataAccountStoredContentUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion:
                ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
        },
    };
}

export function buildProfilePreservingSettingsWriterUpgradeRequired():
    AccountStoredContentUpgradeRequiredV1 {
    return {
        error: CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
        requirement: {
            v: 1,
            kind: 'account-stored-content',
            minimumProtocolVersion:
                ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION,
        },
    };
}

export function evaluateAccountStoredContentCompatibility(
    parseResult: AccountStoredContentCompatibilityDeclarationParseResult,
): AccountStoredContentCompatibilityEvaluation {
    if (
        parseResult.status === 'missing'
        || parseResult.status === 'malformed'
    ) {
        return {
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            supportsMachinePoolChangeProtocol: false,
            supportsSavedSecretResourceChangeProtocol: false,
            outcome: `legacy-${parseResult.status}`,
            declaration: null,
            upgradeRequired: buildAccountStoredContentUpgradeRequired(),
        };
    }

    const declaration = parseResult.declaration;
    if (
        declaration.protocolVersion
        < ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION_V2
    ) {
        return {
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            supportsMachinePoolChangeProtocol: false,
            supportsSavedSecretResourceChangeProtocol: false,
            outcome: 'legacy-protocol-too-old',
            declaration,
            upgradeRequired: buildAccountStoredContentUpgradeRequired(),
        };
    }

    return {
        supportsCurrentProtocol: true,
        supportsPluginDataProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_PLUGIN_DATA_PROTOCOL_VERSION,
        supportsSessionAccessWitnessProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_SESSION_ACCESS_WITNESS_PROTOCOL_VERSION,
        supportsMachinePoolChangeProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_MACHINE_POOL_CHANGE_PROTOCOL_VERSION,
        supportsSavedSecretResourceChangeProtocol:
            declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_SAVED_SECRET_RESOURCE_CHANGE_PROTOCOL_VERSION,
        outcome: 'accepted',
        declaration,
        upgradeRequired: null,
    };
}

export function captureAccountStoredContentCompatibilityForHttpRequest(
    request: FastifyRequest,
): AccountStoredContentCompatibilityEvaluation {
    const evaluation = evaluateAccountStoredContentCompatibility(
        parseAccountStoredContentCompatibilityHttpHeadersV1(request.headers),
    );
    request.accountStoredContentCompatibility = evaluation;
    return evaluation;
}

export function readAccountStoredContentCompatibilityForHttpRequest(
    request: Pick<FastifyRequest, 'accountStoredContentCompatibility'>,
): AccountStoredContentCompatibilityEvaluation {
    return request.accountStoredContentCompatibility ?? {
        supportsCurrentProtocol: false,
        supportsPluginDataProtocol: false,
        supportsSessionAccessWitnessProtocol: false,
        supportsMachinePoolChangeProtocol: false,
        supportsSavedSecretResourceChangeProtocol: false,
        outcome: 'legacy-missing',
        declaration: null,
        upgradeRequired: buildAccountStoredContentUpgradeRequired(),
    };
}

export async function enforceCurrentAccountStoredContentCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<boolean> {
    const evaluation =
        readAccountStoredContentCompatibilityForHttpRequest(request);
    if (!evaluation.supportsCurrentProtocol) {
        await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(
            evaluation.upgradeRequired
            ?? buildAccountStoredContentUpgradeRequired(),
        );
    }
    return !reply.sent;
}

/**
 * Account Settings replacement is opaque to the server, so admission cannot
 * inspect whether one request contains Profile V2 rows. The writer declaration
 * is consequently enforced for every V1/V2 Settings replacement while reads
 * and unrelated stored-content operations remain available to older clients.
 */
export async function enforceProfilePreservingSettingsWriterCompatibilityForHttpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<boolean> {
    const evaluation =
        readAccountStoredContentCompatibilityForHttpRequest(request);
    const supportsProfilePreservingWriter =
        evaluation.declaration !== null
        && evaluation.declaration.protocolVersion
            >= ACCOUNT_STORED_CONTENT_PROFILE_PRESERVING_SETTINGS_WRITER_PROTOCOL_VERSION;
    if (!supportsProfilePreservingWriter) {
        await reply.code(CLIENT_UPGRADE_REQUIRED_HTTP_STATUS).send(
            buildProfilePreservingSettingsWriterUpgradeRequired(),
        );
    }
    return !reply.sent;
}

export function evaluateAccountStoredContentSocketCompatibility(
    auth: unknown,
): AccountStoredContentSocketCompatibilityResult {
    const parseResult =
        parseAccountStoredContentCompatibilitySocketAuthV1(auth);
    return {
        parseResult,
        evaluation: evaluateAccountStoredContentCompatibility(parseResult),
    };
}

export function writeAccountStoredContentCompatibilityForSocket(
    socket: Pick<Socket, 'data'>,
    compatibility: AccountStoredContentSocketCompatibilityResult,
): void {
    socket.data.accountStoredContentCompatibility =
        compatibility.evaluation;
}

export function readAccountStoredContentCompatibilityForSocket(
    socket: Readonly<{ data?: Socket['data'] }>,
): AccountStoredContentCompatibilityEvaluation {
    return socket.data?.accountStoredContentCompatibility ?? {
        supportsCurrentProtocol: false,
        supportsPluginDataProtocol: false,
        supportsSessionAccessWitnessProtocol: false,
        supportsMachinePoolChangeProtocol: false,
        supportsSavedSecretResourceChangeProtocol: false,
        outcome: 'legacy-missing',
        declaration: null,
        upgradeRequired: buildAccountStoredContentUpgradeRequired(),
    };
}

export function buildAccountStoredContentSocketUpgradeError(
    evaluation: AccountStoredContentCompatibilityEvaluation,
): Error & { data: AccountStoredContentUpgradeRequiredV1 } {
    const error = new Error(
        CLIENT_UPGRADE_REQUIRED_ERROR_CODE,
    ) as Error & { data: AccountStoredContentUpgradeRequiredV1 };
    error.data =
        evaluation.upgradeRequired
        ?? buildAccountStoredContentUpgradeRequired();
    return error;
}
