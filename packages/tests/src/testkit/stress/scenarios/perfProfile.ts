import { mulberry32, pickOne } from '../../seed';
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol';
import { createHash } from 'node:crypto';

/** Stable fixture IDs are public dataset labels, never credentials or encryption keys. */
export function perfFixtureId(seed: number, kind: string, index: number): string {
  const bytes = createHash('sha256').update(`performance-fixture:${seed}:${kind}:${index}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Fixture sizes reproduce the fleet and populated Home used by the performance program. */
export function buildPerfProfile(seed: number) {
  const random = mulberry32(seed);
  const projects = ['client', 'service', 'docs', 'automation', 'infrastructure', 'sdk'];
  const machines = Array.from({ length: 137 }, (_, index) => ({
    id: perfFixtureId(seed, 'machine', index),
    host: `dev-${String(index).padStart(3, '0')}`,
    platform: ['linux', 'darwin', 'win32'][index % 3]!,
    homeDir: index % 3 === 2 ? 'C:\\Users\\perf' : '/home/perf',
  }));
  const sessions = Array.from({ length: 192 }, (_, index) => {
    const project = pickOne(random, projects);
    // Seed long Sessions last so their real list rows are reachable in the initial viewport.
    const count = index >= 189 ? 500 : 8 + Math.floor(random() * 24);
    return {
      tag: `perf-${seed}-session-${index}`,
      title: `${project}: ${pickOne(random, ['implement', 'investigate', 'review', 'verify'])} change ${index}`,
      machineIndex: index % machines.length,
      project,
      messages: Array.from({ length: count }, (_, sequence) => ({
        role: sequence % 2 === 0 ? 'user' as const : 'agent' as const,
        text: sequence % 2 === 0
          ? `Check ${project} change ${sequence} and explain the result.`
          : `### ${project} progress ${sequence}\n\n${'The implementation preserves the existing behavior and verifies the changed boundary. '.repeat(8 + Math.floor(random() * 24))}\n\n\`\`\`ts\nconst revision = ${sequence};\n\`\`\``,
      })),
    };
  });
  const artifacts = Array.from({ length: 24 }, (_, index) => ({
    id: perfFixtureId(seed, 'artifact', index),
    header: { title: `${projects[index % projects.length]} investigation ${index}` },
    body: { text: 'Performance fixture design notes.\n'.repeat(64 + index) },
  }));
  const workflows = Array.from({ length: 36 }, (_, index) => {
    const id = perfFixtureId(seed, 'workflow', index);
    return {
      id,
      header: WorkflowDefinitionArtifactHeaderV1Schema.parse({
        kind: 'workflow-definition.v1', definitionId: id,
        revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: `Review ${projects[index % projects.length]} ${index}` },
      }),
      body: WorkflowDefinitionArtifactBodyV1Schema.parse({
        kind: 'workflow-definition.v1', definition: {
          version: 1, inputs: [],
          defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, modelSelection: null, permissionMode: 'default' },
          blocks: [{ kind: 'step', id: 'review', document: { text: 'Review the fixture change.', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
        },
      }),
    };
  });
  return { seed, machines, sessions, artifacts, workflows };
}
