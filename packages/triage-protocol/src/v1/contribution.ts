import {
    defineContributionPoint,
    defineContributionProtocol,
} from '@happier-dev/plugin-sdk/contributions';

import {
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from './bounds.js';
import { TriageSourceDescriptorV1Schema } from './descriptor.js';
import { TriageDetailSurfaceInputV1Schema } from './detail.js';
import { TriagePullRequestStatusResultV1Schema } from './pullRequestStatus.js';
import {
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1Schema,
} from './instances.js';
import {
    TriageGetConnectedAccountInputV1Schema,
    TriageGetCredentialInputV1Schema,
    TriageGetInputV1Schema,
    TriageGetResultV1Schema,
    TriageScanInputV1Schema,
    TriageScanConnectedAccountInputV1Schema,
    TriageScanCredentialInputV1Schema,
    TriageScanResultV1Schema,
} from './operations.js';
import {
    TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    TriagePrepareReviewWorkspaceCredentialInputV1Schema,
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    TriageVerifyReviewWorkspaceInputV1Schema,
    TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
    TriageVerifyReviewWorkspaceCredentialInputV1Schema,
    TriageVerifyReviewWorkspaceResultV1Schema,
} from './workspace.js';
import {
    TriageTaskCreateInputV1Schema, TriageTaskEditInputV1Schema, TriageTaskTransitionInputV1Schema,
    TriageTaskCreateConnectedAccountInputV1Schema, TriageTaskEditConnectedAccountInputV1Schema,
    TriageTaskTransitionConnectedAccountInputV1Schema, TriageTaskWriteResultV1Schema,
    TriageTaskCreateCredentialInputV1Schema, TriageTaskEditCredentialInputV1Schema, TriageTaskTransitionCredentialInputV1Schema,
} from './tasks.js';
import {
    TriageSourceLinkSessionInputV1Schema, TriageSourceLinkSessionResultV1Schema,
    TriageSourceReadSessionLinksInputV1Schema, TriageSourceReadSessionLinksResultV1Schema,
    TriageSourceLinkSessionConnectedAccountInputV1Schema, TriageSourceReadSessionLinksConnectedAccountInputV1Schema,
    TriageSourceLinkSessionCredentialInputV1Schema, TriageSourceReadSessionLinksCredentialInputV1Schema,
} from './sessionLinks.js';

/**
 * The V1 source role contract.
 *
 * The provider-read roles, including optional PR status, are `safe`; `prepareReviewWorkspace` is the one
 * optional source-owned local materialization and is therefore `writesLocal`.
 * Task writes are optional declared roles bound to ordinary source Actions.
 * The source keeps authorization and settlement; other native writes retain
 * their exact named Actions. There is no arbitrary verb/payload operation.
 */
export const TriageSourcesContributionProtocolV1 = defineContributionProtocol({
    id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
    descriptor: TriageSourceDescriptorV1Schema,
    operations: {
        linkSession: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageSourceLinkSessionInputV1Schema },
            resultSchema: TriageSourceLinkSessionResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        readSessionLinks: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageSourceReadSessionLinksInputV1Schema },
            resultSchema: TriageSourceReadSessionLinksResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        create: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskCreateInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        edit: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskEditInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        transition: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageTaskTransitionInputV1Schema },
            resultSchema: TriageTaskWriteResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'writesRemote' },
        },
        listInstances: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageListInstancesInputV1Schema },
            resultSchema: TriageListInstancesResultV1Schema,
            action: { surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], dangerLevel: 'safe' },
        },
        scan: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageScanInputV1Schema },
            resultSchema: TriageScanResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
        get: {
            required: true,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriageGetResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        readPullRequestStatus: {
            required: false,
            input: { kind: 'protocolDefined', schema: TriageGetInputV1Schema },
            resultSchema: TriagePullRequestStatusResultV1Schema,
            action: { surfaces: ['plugin', 'ui'], dangerLevel: 'safe' },
        },
        prepareReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriagePrepareReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriagePrepareReviewWorkspaceResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'writesLocal' },
        },
        verifyReviewWorkspace: {
            required: false,
            input: {
                kind: 'protocolDefined',
                schema: TriageVerifyReviewWorkspaceInputV1Schema,
            },
            resultSchema: TriageVerifyReviewWorkspaceResultV1Schema,
            action: { surfaces: ['plugin'], dangerLevel: 'safe' },
        },
    },
    surfaces: {
        detail: {
            required: true,
            inputSchema: TriageDetailSurfaceInputV1Schema,
            presentation: 'content',
        },
    },
});

/** Exact V1 Action inputs for sources that support connected Accounts only. */
export const TriageSourceConnectedAccountInputsV1 = {
    linkSession: TriageSourceLinkSessionConnectedAccountInputV1Schema,
    readSessionLinks: TriageSourceReadSessionLinksConnectedAccountInputV1Schema,
    create: TriageTaskCreateConnectedAccountInputV1Schema,
    edit: TriageTaskEditConnectedAccountInputV1Schema,
    transition: TriageTaskTransitionConnectedAccountInputV1Schema,
    listInstances: TriageListInstancesInputV1Schema,
    scan: TriageScanConnectedAccountInputV1Schema,
    get: TriageGetConnectedAccountInputV1Schema,
    readPullRequestStatus: TriageGetConnectedAccountInputV1Schema,
    prepareReviewWorkspace: TriagePrepareReviewWorkspaceConnectedAccountInputV1Schema,
    verifyReviewWorkspace: TriageVerifyReviewWorkspaceConnectedAccountInputV1Schema,
} as const satisfies Record<keyof typeof TriageSourcesContributionProtocolV1.operations, unknown>;

/** Exact inputs for a source that materializes connected or machine-native credentials. */
export const TriageSourceCredentialInputsV1 = {
    create: TriageTaskCreateCredentialInputV1Schema,
    edit: TriageTaskEditCredentialInputV1Schema,
    transition: TriageTaskTransitionCredentialInputV1Schema,
    linkSession: TriageSourceLinkSessionCredentialInputV1Schema,
    readSessionLinks: TriageSourceReadSessionLinksCredentialInputV1Schema,
    listInstances: TriageListInstancesInputV1Schema,
    scan: TriageScanCredentialInputV1Schema,
    get: TriageGetCredentialInputV1Schema,
    readPullRequestStatus: TriageGetCredentialInputV1Schema,
    prepareReviewWorkspace: TriagePrepareReviewWorkspaceCredentialInputV1Schema,
    verifyReviewWorkspace: TriageVerifyReviewWorkspaceCredentialInputV1Schema,
} as const satisfies Record<keyof typeof TriageSourcesContributionProtocolV1.operations, unknown>;

/** The target-owned `sources` point admits one V1 contribution per source plugin. */
export const TriageSourcesContributionPointV1 = defineContributionPoint(
    [TriageSourcesContributionProtocolV1],
    { maxContributionsPerContributor: 1 },
);
