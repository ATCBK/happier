import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';

// Codex rust-v0.162.1 protocol/src/account.rs PlanType and is_workspace_account.
// Recognize both sets positively; a new native SKU is not personal by exclusion.
export function classifyCodexUsageAccountScope(planType: unknown): ConnectedAccountMaterialization['usageAccountScope'] {
  switch (planType) {
    case 'free': case 'go': case 'plus': case 'pro': case 'prolite': case 'promax':
      return 'personal';
    case 'team': case 'self_serve_business_prolite': case 'self_serve_business_usage_based':
    case 'business': case 'ent26': case 'enterprise_cbp_automation': case 'enterprise_cbp_usage_based':
    case 'enterprise': case 'edu': case 'edu_plus': case 'edu_pro':
      return 'workspace';
    default:
      return 'unknown';
  }
}
