export const ACTION_POLICY_ACTION_IDS = ['actions.policy.get', 'actions.policy.set', 'actions.policy.reset'] as const;
export type ActionPolicyActionId = typeof ACTION_POLICY_ACTION_IDS[number];
export function isActionPolicyActionId(value: string): value is ActionPolicyActionId {
  return (ACTION_POLICY_ACTION_IDS as readonly string[]).includes(value);
}
