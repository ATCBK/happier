import {
  ConnectedServiceCredentialRecordV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from './connectedServiceSchemas.js';

import { readClaudeOauthCredentialMetadata, type ClaudeOauthCredentialMetadata } from '../providers/claude/oauthProfile.js';

export type ConnectedServiceOauthCredentialRawMetadata = Readonly<{
  claudeAiOauth?: ClaudeOauthCredentialMetadata;
  'claude.ai_oauth'?: ClaudeOauthCredentialMetadata;
}>;

export function normalizeConnectedServiceOauthCredentialRawMetadata(raw: unknown): ConnectedServiceOauthCredentialRawMetadata | null {
  const claudeAiOauth = readClaudeOauthCredentialMetadata(raw);
  return claudeAiOauth ? { claudeAiOauth } : null;
}

export function buildConnectedServiceCredentialRecord(
  params:
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'oauth';
        expiresAt?: number | null;
        oauth: Readonly<{
          accessToken: string;
          refreshToken: string;
          idToken: string | null;
          scope: string | null;
          tokenType: string | null;
          providerAccountId: string | null;
          providerEmail: string | null;
          raw?: ConnectedServiceOauthCredentialRawMetadata | null;
        }>;
      }>
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'token';
        token: Readonly<{
          token: string;
          providerAccountId: string | null;
          providerEmail: string | null;
        }>;
      }>,
): ConnectedServiceCredentialRecordV1 {
  const base = {
    v: 1 as const,
    serviceId: params.serviceId,
    profileId: params.profileId,
    createdAt: params.now,
    updatedAt: params.now,
    expiresAt: params.kind === 'oauth' ? (params.expiresAt ?? null) : null,
  };

  const record: unknown =
    params.kind === 'oauth'
      ? {
          ...base,
          kind: 'oauth' as const,
          oauth: {
            accessToken: params.oauth.accessToken,
            refreshToken: params.oauth.refreshToken,
            idToken: params.oauth.idToken,
            scope: params.oauth.scope,
            tokenType: params.oauth.tokenType,
            providerAccountId: params.oauth.providerAccountId,
            providerEmail: params.oauth.providerEmail,
            raw: normalizeConnectedServiceOauthCredentialRawMetadata(params.oauth.raw),
          },
          token: null,
        }
      : {
          ...base,
          kind: 'token' as const,
          token: {
            token: params.token.token,
            providerAccountId: params.token.providerAccountId,
            providerEmail: params.token.providerEmail,
            raw: null,
          },
        };

  return ConnectedServiceCredentialRecordV1Schema.parse(record);
}
