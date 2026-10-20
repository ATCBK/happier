/** One portable activation artifact for the plugin's Account-owned Actions. */
export const TRIAGE_ACCOUNT_ACTION_EXECUTION_V1 = {
  target: 'account',
  account: { artifactId: 'triage-account-runtime', exportName: 'activate' },
} as const;
