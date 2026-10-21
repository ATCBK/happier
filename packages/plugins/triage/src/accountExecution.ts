/** The authored data Action placement, shared by registration and mounted readiness. */
export const TRIAGE_DATA_ACTION_EXECUTION_V1 = {
  target: 'account',
  account: { artifactId: 'triage-account-runtime', exportName: 'activate' },
} as const;
