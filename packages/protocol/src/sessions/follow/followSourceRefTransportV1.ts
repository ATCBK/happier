import { FollowSourceRefV1Schema, type FollowSourceRefV1 } from './sessionDeliveryMuteV1.js';

export type OtherFollowSourceRefV1 = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;

/** Structured source identities use the query transport, not a bounded router segment. */
export function appendFollowSourceRefQueryV1(path: string, source: FollowSourceRefV1): string {
  const query = new URLSearchParams({ sourceRef: JSON.stringify(FollowSourceRefV1Schema.parse(source)) });
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

export function parseOtherFollowSourceRefV1(raw: string): OtherFollowSourceRefV1 | null {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; }
  const parsed = FollowSourceRefV1Schema.safeParse(value);
  return parsed.success && parsed.data.kind !== 'session' && parsed.data.kind !== 'rule'
    ? parsed.data : null;
}
