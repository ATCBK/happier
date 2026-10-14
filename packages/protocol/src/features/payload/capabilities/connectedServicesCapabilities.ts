import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES = Object.freeze({
  revisionGuard: false,
});

export const ConnectedServicesCredentialDeleteCapabilitiesSchema = lazyZodSchema(() => z._default(z
  .object({
    revisionGuard: z._default(z.optional(z.boolean()), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES.revisionGuard),
  }), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES));

export const DEFAULT_CONNECTED_SERVICES_CAPABILITIES = Object.freeze({
  credentialDelete: DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES,
});

export const ConnectedServicesQualifiedAccountsCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(4),
}));

export const ConnectedServicesCredentialRemovalReviewCapabilitiesSchema = lazyZodSchema(() => z.strictObject({
  protocolVersion: z.literal(1),
}));

export const ConnectedServicesCapabilitiesSchema = lazyZodSchema(() => z._default(z
  .object({
    credentialDelete: z._default(z.optional(ConnectedServicesCredentialDeleteCapabilitiesSchema), DEFAULT_CONNECTED_SERVICES_CREDENTIAL_DELETE_CAPABILITIES),
    qualifiedAccounts: z.optional(ConnectedServicesQualifiedAccountsCapabilitiesSchema),
    credentialRemovalReview: z.optional(ConnectedServicesCredentialRemovalReviewCapabilitiesSchema),
  }), DEFAULT_CONNECTED_SERVICES_CAPABILITIES));

export type ConnectedServicesCapabilities = z.infer<typeof ConnectedServicesCapabilitiesSchema>;
