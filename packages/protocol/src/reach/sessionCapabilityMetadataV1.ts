import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import {
  SessionMcpSelectionV1Schema,
  SessionMcpSelectionRestartRequiredV1Schema,
  type SessionMcpSelectionRestartRequiredV1,
} from '../mcp/servers/sessionSelectionV1.js';
import {
  SessionCapabilitySelectionAuthoringV1Schema,
  SessionSkillSelectionAuthoringV1Schema,
  SessionSkillSelectionV1Schema,
  areSessionCapabilitySelectionsEquivalentV1,
  type SessionCapabilitySelectionV1,
} from './sessionCapabilitySelectionV1.js';

export const SessionSkillSelectionRestartRequiredAuthoringV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), appliedSelection: SessionSkillSelectionAuthoringV1Schema,
}).strict());
export const SessionSkillSelectionRestartRequiredV1Schema = createStoredReadSchema(SessionSkillSelectionRestartRequiredAuthoringV1Schema);
export type SessionSkillSelectionRestartRequiredV1 = z.infer<typeof SessionSkillSelectionRestartRequiredV1Schema>;

export type SessionCapabilityMetadataV1 = Readonly<{
  mcpSelectionV1?: SessionCapabilitySelectionV1['mcp'];
  skillSelectionV1?: SessionCapabilitySelectionV1['skills'];
  mcpSelectionRestartRequiredV1?: SessionMcpSelectionRestartRequiredV1;
  skillSelectionRestartRequiredV1?: SessionSkillSelectionRestartRequiredV1;
}>;

function metadataRecord(metadata: unknown): Readonly<Record<string, unknown>> {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Readonly<Record<string, unknown>> : {};
}

export function readSessionCapabilitySelectionFromMetadataV1(metadata: unknown): Required<SessionCapabilitySelectionV1> {
  const record = metadataRecord(metadata);
  const mcp = SessionMcpSelectionV1Schema.safeParse(record.mcpSelectionV1);
  const skills = SessionSkillSelectionV1Schema.safeParse(record.skillSelectionV1);
  return {
    mcp: mcp.success ? mcp.data : SessionMcpSelectionV1Schema.parse({}),
    skills: skills.success ? skills.data : SessionSkillSelectionV1Schema.parse({}),
  };
}

/** Live-runtime projections read the applied baseline while desired edits remain pending. */
export function readAppliedSessionCapabilitySelectionFromMetadataV1(metadata: unknown): Required<SessionCapabilitySelectionV1> {
  const record = metadataRecord(metadata);
  const desired = readSessionCapabilitySelectionFromMetadataV1(record);
  const mcp = SessionMcpSelectionRestartRequiredV1Schema.safeParse(record.mcpSelectionRestartRequiredV1);
  const skills = SessionSkillSelectionRestartRequiredV1Schema.safeParse(record.skillSelectionRestartRequiredV1);
  return { mcp: mcp.success ? mcp.data.appliedSelection : desired.mcp,
    skills: skills.success ? skills.data.appliedSelection : desired.skills };
}

export function readPendingCapabilityApplyV1(metadata: unknown): Readonly<{ mcp: boolean; skills: boolean }> {
  const desired = readSessionCapabilitySelectionFromMetadataV1(metadata);
  const applied = readAppliedSessionCapabilitySelectionFromMetadataV1(metadata);
  return {
    mcp: !areSessionCapabilitySelectionsEquivalentV1({ mcp: desired.mcp }, { mcp: applied.mcp }),
    skills: !areSessionCapabilitySelectionsEquivalentV1({ skills: desired.skills }, { skills: applied.skills }),
  };
}

/** Desired selections and their applied baselines have one metadata writer. */
export function writeSessionCapabilitySelectionToMetadataV1<TMetadata extends object>(
  metadata: TMetadata,
  next: SessionCapabilitySelectionV1,
  opts: Readonly<{ sessionActive: boolean }>,
): TMetadata & SessionCapabilityMetadataV1 {
  const selection = SessionCapabilitySelectionAuthoringV1Schema.parse(next);
  const applied = readAppliedSessionCapabilitySelectionFromMetadataV1(metadata);
  const result: TMetadata & { -readonly [K in keyof SessionCapabilityMetadataV1]: SessionCapabilityMetadataV1[K] } = { ...metadata };
  if (selection.mcp !== undefined) {
    result.mcpSelectionV1 = selection.mcp;
    if (opts.sessionActive && !areSessionCapabilitySelectionsEquivalentV1({ mcp: selection.mcp }, { mcp: applied.mcp })) {
      result.mcpSelectionRestartRequiredV1 = { v: 1, appliedSelection: applied.mcp };
    } else delete result.mcpSelectionRestartRequiredV1;
  }
  if (selection.skills !== undefined) {
    result.skillSelectionV1 = selection.skills;
    if (opts.sessionActive && !areSessionCapabilitySelectionsEquivalentV1({ skills: selection.skills }, { skills: applied.skills })) {
      result.skillSelectionRestartRequiredV1 = { v: 1, appliedSelection: applied.skills };
    } else delete result.skillSelectionRestartRequiredV1;
  }
  return result;
}

/** An attach to a preserved Agent process cannot acknowledge a launch-owned change. */
export function resolveSelectionRestartMarkersForStartupV1<TMetadata extends object>(input: Readonly<{
  current: TMetadata; applied: SessionCapabilitySelectionV1 | 'preserved_process';
}>): TMetadata & SessionCapabilityMetadataV1 {
  if (input.applied === 'preserved_process') return input.current;
  const applied = SessionCapabilitySelectionAuthoringV1Schema.parse(input.applied);
  const desired = readSessionCapabilitySelectionFromMetadataV1(input.current);
  const result: TMetadata & { -readonly [K in keyof SessionCapabilityMetadataV1]: SessionCapabilityMetadataV1[K] } = { ...input.current };
  if (applied.mcp !== undefined) {
    if (areSessionCapabilitySelectionsEquivalentV1({ mcp: desired.mcp }, { mcp: applied.mcp })) {
      delete result.mcpSelectionRestartRequiredV1;
    } else result.mcpSelectionRestartRequiredV1 = { v: 1, appliedSelection: applied.mcp };
  }
  if (applied.skills !== undefined) {
    if (areSessionCapabilitySelectionsEquivalentV1({ skills: desired.skills }, { skills: applied.skills })) {
      delete result.skillSelectionRestartRequiredV1;
    } else result.skillSelectionRestartRequiredV1 = { v: 1, appliedSelection: applied.skills };
  }
  return result;
}
