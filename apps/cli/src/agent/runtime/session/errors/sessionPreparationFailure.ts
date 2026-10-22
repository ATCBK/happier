/** Code-only failures returned by the daemon MCP bridge and skill delivery.
 * PluginError accepts arbitrary plugin strings; only these host-owned codes
 * may cross startup diagnostic and launch-result boundaries. */
export const SESSION_PREPARATION_FAILURE_PREVIEWS = {
  plugin_mcp_preparation_unavailable: 'Plugin MCP preparation is unavailable. Check the target Machine, then retry the Session.',
  agent_runtime_daemon_service_generation_not_current: 'The runner Agent generation is no longer current. Retry the Session on the target Machine.',
  native_agent_privileged_effect_authority_unavailable: 'Runner daemon authority is unavailable. Check the target Machine, then retry the Session.',
  native_agent_privileged_effect_outcome_unknown: 'Runner daemon preparation could not be confirmed. Check the Session and target Machine before retrying.',
  skills_unavailable: 'Skill delivery is unavailable. Check the target Machine, then retry the Session.',
} as const;

export type SessionPreparationFailureCode = keyof typeof SESSION_PREPARATION_FAILURE_PREVIEWS;

export function readSessionPreparationFailureCode(value: unknown): SessionPreparationFailureCode | null {
  return typeof value === 'string' && Object.hasOwn(SESSION_PREPARATION_FAILURE_PREVIEWS, value)
    ? value as SessionPreparationFailureCode : null;
}
