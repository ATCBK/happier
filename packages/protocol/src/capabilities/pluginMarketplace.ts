import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginUpdatePolicyV1Schema } from '../marketplace/pluginUpdatePolicyV1.js';

/** Development lifecycle facts have one wire owner for daemon, Actions and Settings. */
export const PluginDevelopmentPhaseV1Schema = lazyZodSchema(() => z.enum([
  'observing', 'preparing_dependencies', 'compiling', 'validating',
  'active', 'retained_incumbent', 'unavailable',
]));

export const PluginDevelopmentStatusV1Schema = lazyZodSchema(() => z.object({
  roots: z.array(z.object({
    kind: z.enum(['home', 'workspace', 'explicit']),
    rootPath: z.string().min(1),
    trusted: z.boolean(),
    persisted: z.boolean(),
  }).strict().readonly()).readonly(),
  plugins: z.array(z.object({
    sourceRootPath: z.string().min(1),
    pluginId: z.string().min(1).optional(),
    phase: PluginDevelopmentPhaseV1Schema,
    occurrenceId: z.string().min(1).optional(),
    uiArtifactDigest: z.string().min(1).optional(),
    diagnostic: z.object({ code: z.string().min(1), message: z.string().optional() }).strict().readonly().optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly());
export type PluginDevelopmentStatusV1 = z.infer<typeof PluginDevelopmentStatusV1Schema>;
export type PluginDevelopmentPhaseV1 = z.infer<typeof PluginDevelopmentPhaseV1Schema>;

export const PluginDevelopmentControlResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), status: PluginDevelopmentStatusV1Schema }).strict(),
  z.object({ kind: z.literal('trustRequired'), projectRoot: z.string().min(1), pluginRoot: z.string().min(1),
    status: PluginDevelopmentStatusV1Schema }).strict(),
  z.object({ kind: z.literal('failed'), code: z.string().min(1), message: z.string(),
    status: PluginDevelopmentStatusV1Schema }).strict(),
]));
export type PluginDevelopmentControlResultV1 = z.infer<typeof PluginDevelopmentControlResultV1Schema>;

const DiagnosticSchema = lazyZodSchema(() => z.object({
  code: z.string(), message: z.string(), details: z.unknown().optional(),
}).readonly());
const DistributionSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('npm'), registryOrigin: z.string(), registryProfileId: z.string().optional(), packageName: z.string() }),
  z.object({ kind: z.literal('localPath'), canonicalPath: z.string() }),
  z.object({ kind: z.literal('archive'), source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('localFile'), canonicalPath: z.string() }),
    z.object({ kind: z.literal('remoteUrl'), canonicalUrl: z.string() }),
  ]), integrity: z.string() }),
]));

/** Presentation projection: validate known facts and drop additive unknown detail. */
export const InstalledPluginCapabilityEntryV1Schema = lazyZodSchema(() => z.object({
  pluginId: z.string(), desiredGeneration: z.string().nullable().optional(), appliedGeneration: z.string().nullable().optional(),
  admittedIntegrity: z.string().nullable().optional(), title: z.string(), description: z.string().nullable(),
  version: z.string(), enabled: z.boolean(), rollbackAvailability: z.enum(['available', 'unavailable']).optional(),
  source: z.object({
    kind: z.string(), locator: z.string(), devWatch: z.boolean().optional(), trustPolicy: z.string().optional(),
    installPolicy: z.string().optional(), resolvedPath: z.string().optional(),
  }).readonly(),
  install: z.object({
    mode: z.string(), manifestVersion: z.string(), installedPath: z.string().nullable().optional(),
    updatePolicy: PluginUpdatePolicyV1Schema.optional(),
    trust: z.object({ pluginId: z.string(), distribution: DistributionSchema, state: z.literal('trusted'), approvedAtMs: z.number() }).readonly().optional(),
  }).readonly(),
  compatibility: z.object({ status: z.string(), diagnostics: z.array(DiagnosticSchema).readonly() }).readonly(),
  diagnostics: z.array(DiagnosticSchema).readonly(),
}).readonly());
export type InstalledPluginCapabilityEntryV1 = z.infer<typeof InstalledPluginCapabilityEntryV1Schema>;
export type InstalledPluginCapabilityDiagnosticV1 = InstalledPluginCapabilityEntryV1['diagnostics'][number];
export type InstalledPluginCapabilityDistributionV1 = z.infer<typeof DistributionSchema>;

export const PluginMarketplaceCapabilityDataV1Schema = lazyZodSchema(() => z.object({
  installedPlugins: z.array(InstalledPluginCapabilityEntryV1Schema).readonly().optional(),
  developmentActions: z.object({ create: z.boolean() }).readonly().optional(),
  developmentStatus: PluginDevelopmentStatusV1Schema.optional(),
  pendingChanges: z.array(z.unknown()).readonly().optional(),
}).readonly());
export type PluginMarketplaceCapabilityDataV1 = z.infer<typeof PluginMarketplaceCapabilityDataV1Schema>;
