import { FollowSourceRefV1Schema, type FollowSourceRefV1 } from './sessionDeliveryMuteV1.js';

export type OtherFollowSourceRefV1 = Extract<FollowSourceRefV1, { kind: 'discussion' | 'execution_run' | 'workflow_run' }>;

export function encodeFollowSourceRefPathV1(source: FollowSourceRefV1): string {
  return encodeURIComponent(JSON.stringify(FollowSourceRefV1Schema.parse(source)));
}

export function parseOtherFollowSourceRefPathV1(raw: string): OtherFollowSourceRefV1 | null {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    try { value = JSON.parse(decodeURIComponent(raw)); }
    catch { return null; }
  }
  const parsed = FollowSourceRefV1Schema.safeParse(value);
  return parsed.success && parsed.data.kind !== 'session' && parsed.data.kind !== 'rule'
    ? parsed.data : null;
}
