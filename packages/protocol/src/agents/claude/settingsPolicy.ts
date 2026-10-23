export const CLAUDE_SETTING_SOURCES_V2 = ['user', 'project', 'local'] as const;
export type ClaudeSettingSourceV2 = (typeof CLAUDE_SETTING_SOURCES_V2)[number];

export const CLAUDE_REMOTE_DEBUG_CATEGORIES = ['api', 'mcp', 'hooks', 'file', '1p'] as const;
export type ClaudeRemoteDebugCategory = (typeof CLAUDE_REMOTE_DEBUG_CATEGORIES)[number];

export const CLAUDE_UNIFIED_TERMINAL_HOSTS = ['auto', 'tmux', 'zellij', 'herdr'] as const;
export type ClaudeUnifiedTerminalHost = (typeof CLAUDE_UNIFIED_TERMINAL_HOSTS)[number];

export const CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES = [
  'ask_every_time',
  'resume_from_summary',
  'resume_full_session',
] as const;
export type ClaudeUnifiedTerminalResumeChoice =
  (typeof CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES)[number];
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE:
  ClaudeUnifiedTerminalResumeChoice = 'ask_every_time';

export const CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES = [
  'ask_every_time',
  'always_trust_happier_workspaces',
  'always_reject_happier_workspaces',
] as const;
export type ClaudeUnifiedTerminalWorkspaceTrustPolicy =
  (typeof CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES)[number];
export const DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY:
  ClaudeUnifiedTerminalWorkspaceTrustPolicy = 'ask_every_time';

export const MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS = 16_384;

export function normalizeClaudeUnifiedTerminalHost(raw: unknown): ClaudeUnifiedTerminalHost | null {
  if (typeof raw !== 'string') return null;
  return (CLAUDE_UNIFIED_TERMINAL_HOSTS as readonly string[]).includes(raw) ? (raw as ClaudeUnifiedTerminalHost) : null;
}

function normalizeEnum<TValue extends string>(
  raw: unknown,
  values: readonly TValue[],
): TValue | null {
  return typeof raw === 'string' && (values as readonly string[]).includes(raw)
    ? raw as TValue
    : null;
}

export function normalizeClaudeUnifiedTerminalResumeChoice(
  raw: unknown,
): ClaudeUnifiedTerminalResumeChoice | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES);
}

export function normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(
  raw: unknown,
): ClaudeUnifiedTerminalWorkspaceTrustPolicy | null {
  return normalizeEnum(raw, CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES);
}

export function isValidClaudeRemoteAdvancedOptionsJson(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

export function normalizeClaudeRemoteAdvancedOptionsJson(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!isValidClaudeRemoteAdvancedOptionsJson(trimmed)) return '';
  const parsed = JSON.parse(trimmed) as unknown;
  const normalized = JSON.stringify(parsed);
  return normalized.length <= MAX_CLAUDE_REMOTE_ADVANCED_OPTIONS_JSON_CHARS ? normalized : '';
}

export const CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS = ['app_and_terminal', 'app_only', 'terminal_only'] as const;
export type ClaudeUnifiedTerminalResponseLocation = (typeof CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS)[number];

export function resolveClaudeUnifiedTerminalResponseLocations(settings: Readonly<Record<string, unknown>>): Readonly<{
  question: ClaudeUnifiedTerminalResponseLocation;
  permission: ClaudeUnifiedTerminalResponseLocation;
}> {
  const fallback = settings.claudeLocalPermissionBridgeEnabled === false ? 'terminal_only' : 'app_and_terminal';
  return {
    question: normalizeEnum(settings.claudeUnifiedTerminalQuestionResponseLocation, CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS) ?? fallback,
    permission: normalizeEnum(settings.claudeUnifiedTerminalPermissionResponseLocation, CLAUDE_UNIFIED_TERMINAL_RESPONSE_LOCATIONS) ?? fallback,
  };
}

/** Retained 0.2 flat Account settings must be translated before plugin declaration defaults. */
export function backfillClaudeUnifiedTerminalResponseLocations(settings: Record<string, unknown>): Record<string, unknown> {
  if (settings.claudeLocalPermissionBridgeEnabled !== false) return settings;
  const locations = resolveClaudeUnifiedTerminalResponseLocations(settings);
  return {
    ...settings,
    claudeUnifiedTerminalQuestionResponseLocation: locations.question,
    claudeUnifiedTerminalPermissionResponseLocation: locations.permission,
  };
}
