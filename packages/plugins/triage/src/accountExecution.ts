type TriageDataExecutionDeclaration =
  | Readonly<{ target: 'daemon' }>
  | Readonly<{ target: 'account'; account: Readonly<{ artifactId: string; exportName: string }> }>;

/** The authored data Action placement, shared by registration and mounted readiness. */
export const TRIAGE_DATA_ACTION_EXECUTION_V1 = { target: 'daemon' } as const satisfies TriageDataExecutionDeclaration;
