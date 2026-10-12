export type CodexCloudAuthFileTokens = Readonly<{
  accessToken: string;
  idToken: string | null;
  accountId: string | null;
}>;

export type CodexCloudAuthFile = Readonly<{
  auth_mode: 'chatgptAuthTokens';
  OPENAI_API_KEY: null;
  access_token: string;
  refresh_token: '';
  id_token: string;
  account_id: string | null;
  tokens: Readonly<{
    access_token: string;
    refresh_token: '';
    id_token: string;
    account_id: string | null;
  }>;
  last_refresh: string;
}>;

export function buildCodexCloudAuthFile(params: CodexCloudAuthFileTokens & Readonly<{ lastRefreshIso: string }>): CodexCloudAuthFile {
  const tokens = {
    access_token: params.accessToken,
    // Codex's TokenData requires this field, but external auth has no rotation authority.
    refresh_token: '',
    id_token: params.idToken ?? params.accessToken,
    account_id: params.accountId,
  } as const;
  return {
    auth_mode: 'chatgptAuthTokens',
    OPENAI_API_KEY: null,
    ...tokens,
    tokens,
    last_refresh: params.lastRefreshIso,
  };
}

/** External auth has no native token-rotation authority: readiness requires the selected projection. */
export function isCodexCloudAuthFileProjectionCurrent(value: unknown, expected: CodexCloudAuthFileTokens): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const file = value as Record<string, unknown>;
  if (!file.tokens || typeof file.tokens !== 'object' || Array.isArray(file.tokens)) return false;
  const tokens = file.tokens as Record<string, unknown>;
  const expectedTokens = {
    access_token: expected.accessToken,
    refresh_token: '',
    id_token: expected.idToken ?? expected.accessToken,
    account_id: expected.accountId,
  };
  return file.auth_mode === 'chatgptAuthTokens'
    && (file.OPENAI_API_KEY === undefined || file.OPENAI_API_KEY === null)
    && typeof file.last_refresh === 'string' && Number.isFinite(Date.parse(file.last_refresh))
    && Object.entries(expectedTokens).every(([key, token]) => tokens[key] === token
      && (file[key] === undefined || file[key] === token));
}
