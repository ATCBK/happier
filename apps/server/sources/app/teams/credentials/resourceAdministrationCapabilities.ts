import { TeamCredentialResourceAdministrationCapabilitiesV1Schema, type TeamCredentialDisclosureCeilingV1, type TeamCredentialResourceAdministrationCapabilitiesV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';

type AdministrationCapabilityInput = Readonly<{
    resource: Readonly<{
        enabled: boolean;
        disclosureCeiling: TeamCredentialDisclosureCeilingV1;
    }>;
    isSourceCustodian: boolean;
    isQualifiedTeamManager: boolean;
    isQualifiedTeamMember: boolean;
}>;

/**
 * The one operation-specific administration projector consumed by both Team
 * administration and source-detail administration reads.
 *
 * Mutation leaves remain authoritative and repeat their currentness checks;
 * this projection is the truthful, least-privilege UI/API description of the
 * same roles, never an admission token.
 */
export function projectTeamCredentialResourceAdministrationCapabilities(
    input: AdministrationCapabilityInput,
): TeamCredentialResourceAdministrationCapabilitiesV1 {
    const manager = input.isQualifiedTeamManager;
    const custodian = input.isSourceCustodian;
    return TeamCredentialResourceAdministrationCapabilitiesV1Schema.parse({
        manageAudience: manager,
        managePolicy: manager,
        manageLimits: manager,
        updateBrokerPlacement: custodian,
        narrowDisclosure: custodian && input.resource.disclosureCeiling === "direct_allowed",
        widenDisclosure: custodian && input.resource.disclosureCeiling === "brokered_only",
        refreshDirectMaterial: custodian
            && input.isQualifiedTeamMember
            && input.resource.enabled
            && input.resource.disclosureCeiling === "direct_allowed",
        disable: input.resource.enabled && (manager || custodian),
        enable: !input.resource.enabled && manager,
        delete: manager || custodian,
    });
}
