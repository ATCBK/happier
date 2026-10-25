import { classifyVoiceProviderHttpFailure as canonicalClassifyVoiceProviderHttpFailure } from '@happier-dev/protocol/voice/providerOperations';
import { VOICE_SPEECH_OUTPUT_MAX_BYTES as canonicalVoiceSpeechOutputMaxBytes, VoiceCredentialSlotIdSchema as canonicalVoiceCredentialSlotIdSchema, VoiceProviderContributionSchema as canonicalVoiceProviderContributionSchema, VoiceServiceMarkSchema as canonicalVoiceServiceMarkSchema, VoiceProviderSettingsPresentationSchema as canonicalVoiceProviderSettingsPresentationSchema, resolveVoiceProviderLanguagePreference as canonicalResolveVoiceProviderLanguagePreference } from '@happier-dev/protocol/plugins/contributions/voice';
import type {
    VoiceAvailabilityPlatform,
    VoiceCredentialAccessPhase,
    VoiceCredentialDeclaration,
    VoiceCredentialOperationProjection,
    VoiceCredentialSlotId,
    VoiceProviderContribution,
    VoiceServiceMark,
    VoiceProviderSettings,
    VoiceProviderSettingsPresentation,
    VoiceProviderSettingsPresentationField,
    VoiceRawCredentialGrantDeclaration,
    VoiceSettingReadinessDeclaration,
} from '@happier-dev/protocol/plugins/contributions/voice';
import { VoiceModelPackContributionV1Schema as canonicalVoiceModelPackContributionV1Schema, VoiceModelPackExecutionHostV1Schema as canonicalVoiceModelPackExecutionHostV1Schema, VoiceModelPackLicenseV1Schema as canonicalVoiceModelPackLicenseV1Schema, VoiceModelPackLocalIdV1Schema as canonicalVoiceModelPackLocalIdV1Schema, VoiceModelPackManifestV1Schema as canonicalVoiceModelPackManifestV1Schema, VoiceModelPackRuntimeV1Schema as canonicalVoiceModelPackRuntimeV1Schema } from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import { VoiceModelPackDirectoryArtifactV1Schema as canonicalVoiceModelPackDirectoryArtifactV1Schema, VoiceModelPackFileArtifactV1Schema as canonicalVoiceModelPackFileArtifactV1Schema, VoiceModelPackKokoroArtifactsV1Schema as canonicalVoiceModelPackKokoroArtifactsV1Schema, VoiceModelPackSupportArtifactKindV1Schema as canonicalVoiceModelPackSupportArtifactKindV1Schema, VoiceModelPackSupportArtifactV1Schema as canonicalVoiceModelPackSupportArtifactV1Schema, VoiceModelPackTransducerArtifactsV1Schema as canonicalVoiceModelPackTransducerArtifactsV1Schema } from '@happier-dev/protocol/voice/modelPacks/artifactRolesV1';
import type {
    VoiceModelPackContributionV1,
    VoiceModelPackDirectoryArtifactV1,
    VoiceModelPackExecutionHostV1,
    VoiceModelPackFileArtifactV1,
    VoiceModelPackKokoroArtifactsV1,
    VoiceModelPackLicenseV1,
    VoiceModelPackManifestV1,
    VoiceModelPackRuntimeV1,
    VoiceModelPackSupportArtifactKindV1,
    VoiceModelPackSupportArtifactV1,
    VoiceModelPackTransducerArtifactsV1,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
import * as z from 'zod/mini';
export {
    VoiceAttemptFailureKindSchema, VoiceAttemptRecoveryActionSchema, VoiceAttemptPresentationSchema,
} from '@happier-dev/protocol/voice/attemptPresentation';
export type {
    VoiceAttemptFailureKind, VoiceAttemptRecoveryAction, VoiceAttemptPresentation,
} from '@happier-dev/protocol/voice/attemptPresentation';

import type { InteractionsService } from '../interactions.js';
import type { PluginSettingsActionRuntime } from '../settingsActions.js';
import type { PluginContributionLocalId } from '../identity.js';
import type {
    RealtimeVoiceProviderRuntime,
    VoiceClientToolDefinition,
} from './client.js';
import type { SpeechProviderRuntime } from './speech.js';
import type { VoiceCredentialAccess, VoiceSchema } from './contracts.js';

export type { ConnectedAccountHttpHeadersRequest } from '../connectedAccounts.js';

/** Service-declared presentation facts, validated by the canonical contribution schema. */
export type VoicePrivacyFacts = NonNullable<VoiceProviderSettings['privacyFacts']>;

export type { VoiceAccountOperationService, VoiceRawCredentialAccess, VoiceCredentialAccess, VoiceSchema } from './contracts.js';

function isVoiceRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function createVoiceRecordSchema<TOutput>(
    valueSchema: VoiceSchema<TOutput>,
): VoiceSchema<Readonly<Record<string, TOutput>>> {
    return z.transform((value, context) => {
        if (!isVoiceRecord(value)) {
            context.issues.push({ code: 'invalid_type', expected: 'record', input: value });
            return z.NEVER;
        }
        const entries: [string, TOutput][] = [];
        for (const [key, entry] of Object.entries(value)) {
            const parsed = valueSchema.safeParse(entry);
            if (parsed.success) entries.push([key, parsed.data]);
            // Normalized issues are forwarded through Mini's raw-issue boundary.
            else context.issues.push(...parsed.error.issues.map(issue => ({
                ...issue,
                input: entry,
                path: [key, ...issue.path],
            } as z.core.$ZodRawIssue)));
        }
        return context.issues.length > 0 ? z.NEVER : Object.freeze(Object.fromEntries(entries));
    });
}

export function withVoiceSchemaField<
    TBase extends Readonly<Record<string, unknown>>,
    TFieldName extends string,
    TField,
>(
    baseSchema: VoiceSchema<TBase>,
    fieldName: TFieldName,
    fieldSchema: VoiceSchema<TField>,
): VoiceSchema<
    TBase extends unknown
        ? TFieldName extends keyof TBase
            ? [Exclude<TBase[TFieldName], undefined>] extends [never]
                ? TBase
                : {} extends Pick<TBase, TFieldName>
                    ? Omit<TBase, TFieldName> & Readonly<Partial<Record<TFieldName, TField>>>
                    : Omit<TBase, TFieldName> & Readonly<Record<TFieldName, TField>>
            : TBase
        : never
>;
export function withVoiceSchemaField(
    baseSchema: VoiceSchema<Readonly<Record<string, unknown>>>,
    fieldName: string,
    fieldSchema: VoiceSchema<unknown>,
): VoiceSchema<Readonly<Record<string, unknown>>> {
    return z.pipe(baseSchema, z.transform((parsed, context) => {
        if (!isVoiceRecord(parsed)) {
            context.issues.push({ code: 'custom', input: parsed, message: 'invalid_voice_schema_field_base' });
            return z.NEVER;
        }
        if (!Object.hasOwn(parsed, fieldName)) return parsed;
        const field = fieldSchema.safeParse(parsed[fieldName]);
        if (!field.success) {
            // Normalized issues are forwarded through Mini's raw-issue boundary.
            context.issues.push(...field.error.issues.map(issue => ({
                ...issue,
                input: parsed[fieldName],
                path: [fieldName, ...issue.path],
            } as z.core.$ZodRawIssue)));
            return z.NEVER;
        }
        return Object.freeze({ ...parsed, [fieldName]: field.data });
    }));
}

export type {
    VoiceAvailabilityPlatform,
    VoiceCredentialAccessPhase,
    VoiceCredentialDeclaration,
    VoiceCredentialOperationProjection,
    VoiceCredentialSlotId,
    VoiceProviderContribution,
    VoiceServiceMark,
    VoiceProviderSettings,
    VoiceProviderSettingsPresentation,
    VoiceProviderSettingsPresentationField,
    VoiceRawCredentialGrantDeclaration,
    VoiceSettingReadinessDeclaration,
} from '@happier-dev/protocol/plugins/contributions/voice';

export type {
    VoiceModelPackContributionV1,
    VoiceModelPackDirectoryArtifactV1,
    VoiceModelPackExecutionHostV1,
    VoiceModelPackFileArtifactV1,
    VoiceModelPackKokoroArtifactsV1,
    VoiceModelPackLicenseV1,
    VoiceModelPackManifestV1,
    VoiceModelPackRuntimeV1,
    VoiceModelPackSupportArtifactKindV1,
    VoiceModelPackSupportArtifactV1,
    VoiceModelPackTransducerArtifactsV1,
} from '@happier-dev/protocol/voice/modelPacks/contributionV1';
export const classifyVoiceProviderHttpFailure: (
    status: number,
) => 'credential_unavailable' | 'rate_limited' | 'provider_response_invalid' | null = canonicalClassifyVoiceProviderHttpFailure;
export const VOICE_SPEECH_OUTPUT_MAX_BYTES: number = canonicalVoiceSpeechOutputMaxBytes;
export const VoiceCredentialSlotIdSchema: VoiceSchema<VoiceCredentialSlotId> = canonicalVoiceCredentialSlotIdSchema;
export const VoiceProviderContributionSchema: VoiceSchema<VoiceProviderContribution> = canonicalVoiceProviderContributionSchema;
export const VoiceServiceMarkSchema: VoiceSchema<VoiceServiceMark> = canonicalVoiceServiceMarkSchema;
export const VoiceProviderSettingsPresentationSchema: VoiceSchema<VoiceProviderSettingsPresentation> = canonicalVoiceProviderSettingsPresentationSchema;
export const resolveVoiceProviderLanguagePreference: (
    preference: string | null,
    supportedLanguageCodes: readonly string[],
) => string | null = canonicalResolveVoiceProviderLanguagePreference;
export const VoiceModelPackContributionV1Schema: VoiceSchema<VoiceModelPackContributionV1> = canonicalVoiceModelPackContributionV1Schema;
export const VoiceModelPackDirectoryArtifactV1Schema: VoiceSchema<VoiceModelPackDirectoryArtifactV1> = canonicalVoiceModelPackDirectoryArtifactV1Schema;
export const VoiceModelPackExecutionHostV1Schema: VoiceSchema<VoiceModelPackExecutionHostV1> = canonicalVoiceModelPackExecutionHostV1Schema;
export const VoiceModelPackFileArtifactV1Schema: VoiceSchema<VoiceModelPackFileArtifactV1> = canonicalVoiceModelPackFileArtifactV1Schema;
export const VoiceModelPackKokoroArtifactsV1Schema: VoiceSchema<VoiceModelPackKokoroArtifactsV1> = canonicalVoiceModelPackKokoroArtifactsV1Schema;
export const VoiceModelPackLicenseV1Schema: VoiceSchema<VoiceModelPackLicenseV1> = canonicalVoiceModelPackLicenseV1Schema;
export const VoiceModelPackLocalIdV1Schema: VoiceSchema<string> = canonicalVoiceModelPackLocalIdV1Schema;
export const VoiceModelPackManifestV1Schema: VoiceSchema<VoiceModelPackManifestV1> = canonicalVoiceModelPackManifestV1Schema;
export const VoiceModelPackRuntimeV1Schema: VoiceSchema<VoiceModelPackRuntimeV1> = canonicalVoiceModelPackRuntimeV1Schema;
export const VoiceModelPackSupportArtifactKindV1Schema: VoiceSchema<VoiceModelPackSupportArtifactKindV1> = canonicalVoiceModelPackSupportArtifactKindV1Schema;
export const VoiceModelPackSupportArtifactV1Schema: VoiceSchema<VoiceModelPackSupportArtifactV1> = canonicalVoiceModelPackSupportArtifactV1Schema;
export const VoiceModelPackTransducerArtifactsV1Schema: VoiceSchema<VoiceModelPackTransducerArtifactsV1> = canonicalVoiceModelPackTransducerArtifactsV1Schema;

export type VoiceSettingsActionContext = Readonly<{
    credentials: VoiceCredentialAccess<'settings'>;
    interactions: Pick<InteractionsService, 'askQuestions'>;
    signal: AbortSignal;
    tools: readonly VoiceClientToolDefinition[];
}>;

/** The complete runtime shape accepted by one `voiceProviders.register` call. */
export type RegisteredVoiceProviderRuntime = (
    | RealtimeVoiceProviderRuntime
    | SpeechProviderRuntime
) & Readonly<{
    settingsActions?: PluginSettingsActionRuntime<VoiceSettingsActionContext>;
}>;

export type VoiceProvidersRegistrationApi = Readonly<{
    register(
        localId: PluginContributionLocalId,
        runtime: RegisteredVoiceProviderRuntime,
    ): void;
}>;
