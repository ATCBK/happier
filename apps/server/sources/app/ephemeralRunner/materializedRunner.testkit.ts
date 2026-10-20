import { randomUUID } from "node:crypto";

import * as privacyKit from "privacy-kit";
import tweetnacl from "tweetnacl";
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';

import {
    signMachineInstallationProof,
    type MachineInstallationProofV1,
} from "@happier-dev/protocol/machines/identity/installationIdentity";

import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";

export type MaterializedEphemeralRunnerFixture = Readonly<{
    accountId: string;
    activationId: string;
    sessionId: string;
    machineId: string;
    installationId: string;
    installationPublicKey: string;
    installationProof: MachineInstallationProofV1;
    /** Restricted Runner bearer for the exact materialized Session and Machine. */
    token: string;
    /** Ordinary creator credential used to prove unrelated sockets survive. */
    accountToken: string;
}>;

function encodeKey(bytes: Uint8Array): string {
    return privacyKit.encodeBase64(Uint8Array.from(bytes), "base64url").replace(/=+$/u, "");
}

/**
 * Seeds the exact row tuple one materialization transaction commits, so socket,
 * presence and revocation checks exercise the real admission owners instead of
 * rebuilding a Runner-shaped fixture per suite.
 */
export async function createMaterializedEphemeralRunnerFixture(
    options: Readonly<{
        sessionActive?: boolean;
        sessionLastActiveAt?: Date;
    }> = {},
): Promise<MaterializedEphemeralRunnerFixture> {
    const account = await db.account.create({
        data: { publicKey: `runner-fixture-${randomUUID()}`, encryptionMode: "plain" },
    });
    const activationId = randomUUID();
    const sessionId = `runner-session-${randomUUID()}`;
    const machineId = `runner-machine-${randomUUID()}`;
    const installationId = `runner-installation-${randomUUID()}`;
    const installation = tweetnacl.sign.keyPair();
    const installationPublicKey = encodeKey(installation.publicKey);
    const installationPrivateKey = encodeKey(installation.secretKey);

    await db.session.create({
        data: {
            id: sessionId,
            accountId: account.id,
            tag: `runner-tag-${randomUUID()}`,
            metadata: "{}",
            encryptionMode: "plain",
            metadataLayoutVersion: 1,
            ...(options.sessionActive !== undefined ? { active: options.sessionActive } : {}),
            ...(options.sessionLastActiveAt ? { lastActiveAt: options.sessionLastActiveAt } : {}),
        },
    });
    await db.machine.create({
        data: {
            id: machineId,
            accountId: account.id,
            kind: "ephemeral_session_runner",
            metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId,
            installationPublicKey: Buffer.from(installation.publicKey),
        },
    });
    await db.accessKey.create({
        data: { accountId: account.id, sessionId, machineId, data: "runner-scoped-access" },
    });
    await db.ephemeralRunnerActivation.create({
        data: {
            id: activationId,
            creatorAccountId: account.id,
            creatorTokenEpoch: account.tokenEpoch,
            draftId: `runner-draft-${randomUUID()}`,
            sessionId,
            machineId,
            state: "materialized",
            workspacePolicy: "choose_on_endpoint",
            homeServerIdentityId: "srv_runner_fixture",
            activationSigningPublicKey: installationPublicKey,
            authoringCommitment: "a".repeat(43),
            artifact: {},
            endpointFactsRecipient: { mode: "plain", creatorAccountId: account.id },
        },
    });

    const token = await auth.createToken(
        account.id,
        {
            ephemeralSessionRunnerPrincipal: {
                kind: "ephemeral_session_runner" as const,
                authority: "session_runtime" as const,
                accountId: account.id,
                activationId,
                sessionId,
                machineId,
                installationId,
                installationPublicKey,
                creatorTokenEpoch: account.tokenEpoch,
            },
        },
        { kind: "ephemeral_session_runner", authority: "session_runtime" },
    );
    const accountToken = await auth.createToken(
        account.id,
        undefined,
        { kind: "account", authority: "present_user" },
    );

    return {
        accountId: account.id,
        activationId,
        sessionId,
        machineId,
        installationId,
        installationPublicKey,
        installationProof: signMachineInstallationProof({
            payload: { version: 1, installationId, machineId, accountId: account.id },
            privateKey: installationPrivateKey,
        }),
        token,
        accountToken,
    };
}
