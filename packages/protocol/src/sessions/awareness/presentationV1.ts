import type { SessionAwarenessProjectionV1 } from './projectionV1.js';
import { isSessionAwarenessContentReadableV1 } from './availability.js';
import type { SessionManagedSessionsV1 } from '../follow/sessionManagerV1.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

export type SessionAwarenessPresentationFactsV1 = Readonly<{
  runtime: SessionAwarenessProjectionV1['runtime'];
  encryption?: SessionAwarenessProjectionV1['encryption'];
  lifecycle?: SessionAwarenessProjectionV1['lifecycle'];
  freshness?: SessionAwarenessProjectionV1['freshness'];
  operational: Readonly<Pick<SessionAwarenessProjectionV1['operational'], 'primary'>> & Readonly<{
    reasons?: readonly SessionAwarenessProjectionV1['operational']['reasons'][number][];
  }>;
}>;

/** Serializable facet vocabulary for the canonical presentation projection below. */
export const SessionAwarenessPresentationStateV1Schema = lazyZodSchema(() => z.enum([
  'preparing', 'repair_needed', 'locked', 'access_pending', 'setup_required', 'content_unavailable', 'unknown',
  'failed', 'permission_required', 'action_required', 'ready', 'pending_input',
  'archived', 'recoverable_unservable', 'resuming', 'disconnected', 'stale', 'background_active', 'waiting', 'thinking',
]));
export type SessionAwarenessPresentationStateV1 = z.infer<typeof SessionAwarenessPresentationStateV1Schema>;

/** One precedence for localized Session words, Work buckets and tones. No lifecycle is changed. */
export function readSessionAwarenessPresentationV1(awareness: SessionAwarenessPresentationFactsV1): SessionAwarenessPresentationStateV1 {
  if (awareness.lifecycle === 'archived') return 'archived';
  // List hydration has no content verdict yet, but the Home's public inactive fact is known.
  if (awareness.encryption === 'unknown' && awareness.runtime === 'offline') return 'disconnected';
  if (awareness.encryption !== undefined && !isSessionAwarenessContentReadableV1(awareness.encryption)) return awareness.encryption;
  if (awareness.operational.reasons?.includes('runtime_unservable')) return 'recoverable_unservable';
  if (awareness.operational.reasons?.includes('resuming')) return 'resuming';
  if (awareness.runtime === 'offline') return 'disconnected';
  if (awareness.freshness === 'stale') return 'stale';
  // Operational evidence and runtime reachability are orthogonal: an active turn or pending
  // request stays meaningful without a presence channel, while no operational fact stays unknown.
  if (awareness.runtime === 'unknown' && awareness.operational.primary === 'none') return 'unknown';
  return awareness.operational.primary === 'none'
    ? awareness.runtime === 'background_active' ? 'background_active' : 'waiting'
    : awareness.operational.primary === 'working' ? 'thinking' : awareness.operational.primary;
}

/** The incumbent Session status mapping, shared by Work presentation and input discovery. */
export function readSessionAwarenessWorkStatusV1(input: Readonly<{
  awareness: SessionAwarenessPresentationFactsV1;
  settled?: boolean;
}>): Readonly<{
  bucket: 'needs_you' | 'working' | 'finished' | 'idle' | 'offline';
  tone: 'neutral' | 'attention' | 'danger';
}> {
  const state = readSessionAwarenessPresentationV1(input.awareness);
  if (state === 'failed') return { bucket: 'needs_you', tone: 'danger' };
  if (state === 'permission_required' || state === 'action_required') return { bucket: 'needs_you', tone: 'attention' };
  // A settlement the runtime can no longer stand behind reads offline.
  if (state === 'disconnected' || state === 'recoverable_unservable') return { bucket: 'offline', tone: 'neutral' };
  if (input.settled === true && (state === 'ready' || state === 'waiting')) return { bucket: 'finished', tone: 'neutral' };
  return { bucket: state === 'thinking' ? 'working' : 'idle', tone: 'neutral' };
}

/** Work groups keep idle, finished and offline rows together under Recent. */
export function readSessionWorkStateGroupV1(
  bucket: ReturnType<typeof readSessionAwarenessWorkStatusV1>['bucket'],
): 'needsYou' | 'working' | 'recent' {
  switch (bucket) {
    case 'needs_you': return 'needsYou';
    case 'working': return 'working';
    case 'finished':
    case 'idle':
    case 'offline': return 'recent';
  }
}

/** Compact report counts use the same Work vocabulary as the individual Session rows. */
export function readSessionManagedSessionsPresentationV1(
  reports: Pick<SessionManagedSessionsV1, 'working' | 'needsYou' | 'stalled'>,
): Readonly<{ bucket: 'needs_you' | 'working' | 'offline' | 'idle'; count: number }> {
  if (reports.needsYou > 0) return { bucket: 'needs_you', count: reports.needsYou };
  if (reports.working > 0) return { bucket: 'working', count: reports.working };
  if (reports.stalled > 0) return { bucket: 'offline', count: reports.stalled };
  return { bucket: 'idle', count: 0 };
}
