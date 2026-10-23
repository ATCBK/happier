import type {
  LeftBehindRowV1,
  MachineProcessesAnswerV1,
  OwnerRowV1,
  ProcessRowV1,
} from '@happier-dev/protocol/machines/processes/machineProcessesV1';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** One process as the daemon projects it (`projectMachineProcesses`): ref = rowId, parent = a ref or the owner key. */
export function processRow(
  ref: string,
  parentRowId: string,
  input: Partial<ProcessRowV1> = {},
): ProcessRowV1 {
  return {
    rowId: ref,
    ref,
    parentRowId,
    name: ref,
    pid: 100 + ref.length,
    startedAtMs: 1_000,
    memoryBytes: 10 * MB,
    memoryKind: 'rss',
    cpuPercent: 0,
    level: 'proven',
    ...input,
  };
}

function owner(
  rowId: string,
  input: Pick<OwnerRowV1, 'owner'> & Partial<OwnerRowV1>,
): OwnerRowV1 {
  const members = input.members ?? [];
  const memoryBytes = members.reduce(
    (sum, row) => sum + (row.memoryBytes ?? 0),
    0,
  );
  const cpuPercent = members.reduce(
    (sum, row) => sum + (row.cpuPercent ?? 0),
    0,
  );
  return {
    rowId,
    state: 'running',
    totals: { memoryBytes, cpuPercent, processCount: members.length },
    members,
    ...(members[0] && (members[0].level === 'proven' || members[0].level === 'likely')
      ? { root: { ref: members[0].ref, level: members[0].level } } : {}),
    ...input,
  };
}

/** leeroy-mbp (lab `rp` H): a session open in place, a dev server, Happier itself and three left behind. */
export function createProcessesAnswer(
  overrides: Partial<MachineProcessesAnswerV1> = {},
): MachineProcessesAnswerV1 {
  const session = 'session:refactor';
  const runner = processRow('runner', session, {
    name: 'happier',
    command: 'happier session',
    cpuPercent: 0.3,
    memoryBytes: 90 * MB,
    startedAtMs: 500,
  });
  const members = [
    runner,
    processRow('agent', 'runner', {
      name: 'claude',
      role: 'agent',
      command: 'claude',
      cpuPercent: 0.9,
      memoryBytes: 620 * MB,
    }),
    processRow('shell', 'runner', {
      name: 'zsh',
      role: 'tool_shell',
      command: 'zsh -lc pnpm vitest --watch',
      cpuPercent: 0.1,
      memoryBytes: 30 * MB,
    }),
    processRow('vitest', 'shell', {
      name: 'node',
      role: 'test_runner',
      command: 'node …/vitest',
      cpuPercent: 2.3,
      memoryBytes: 1.1 * GB,
    }),
    processRow('tsgo', 'runner', {
      name: 'tsgo',
      role: 'type_checker',
      command: 'tsgo --watch',
      cpuPercent: 1.8,
      memoryBytes: 1.3 * GB,
    }),
    processRow('vite', 'runner', {
      name: 'node',
      role: 'dev_server',
      command: 'node node_modules/.bin/vite --port 5173',
      cpuPercent: 0.5,
      memoryBytes: 480 * MB,
      level: 'likely',
      ports: [{ port: 5173, inventoryEntryId: 'entry-5173' }],
      cwd: '/Users/leeroy/dev/happier/apps/ui',
    }),
    processRow('mcp-github', 'runner', {
      name: 'node',
      role: 'mcp_server',
      command: 'node …/mcp-server-github',
      cpuPercent: 0,
      memoryBytes: 96 * MB,
    }),
    processRow('mcp-happier', 'runner', {
      name: 'happier',
      role: 'mcp_server',
      command: 'happier mcp',
      cpuPercent: 0,
      memoryBytes: 64 * MB,
    }),
  ];
  const website = processRow('website', 'service:website', {
    name: 'node',
    role: 'dev_server',
    command: 'node …/next dev',
    cpuPercent: 0.4,
    memoryBytes: 1.2 * GB,
    ports: [{ port: 3000, inventoryEntryId: 'entry-3000' }],
  });
  const daemon = processRow('daemon', 'happier', {
    name: 'happier',
    command: 'happier daemon',
    cpuPercent: 0,
    memoryBytes: 186 * MB,
  });
  const left = (
    ref: string,
    input: Partial<ProcessRowV1>,
  ): LeftBehindRowV1 => ({
    ...processRow(ref, 'session:ended', input),
    level: 'left_behind',
    owner: { kind: 'session', sessionId: 'ended' },
    confirmedAtMs: 5_000,
  });
  const owners = [
    owner(session, {
      owner: { kind: 'session', sessionId: 'refactor' },
      members,
    }),
    owner('service:website', {
      owner: { kind: 'service', serviceId: 'website' },
      members: [website],
    }),
    owner('happier', { owner: { kind: 'happier' }, members: [daemon] }),
  ];
  const happierMemory = owners.reduce(
    (sum, row) => sum + (row.totals.memoryBytes ?? 0),
    0,
  );
  const happierCpu = owners.reduce(
    (sum, row) => sum + (row.totals.cpuPercent ?? 0),
    0,
  );
  const leftBehind = [
    left('left-next', {
      name: 'node',
      role: 'dev_server',
      command: 'node …/next dev',
      memoryBytes: 640 * MB,
      cpuPercent: 0.1,
      ports: [{ port: 3002, inventoryEntryId: 'entry-3002' }],
    }),
    left('left-chrome', {
      name: 'chrome',
      role: 'browser',
      command: 'chrome --headless',
      memoryBytes: 610 * MB,
    }),
    left('left-postgres', {
      name: 'postgres',
      role: 'database',
      command: 'postgres -D .pgdata',
      memoryBytes: 150 * MB,
      ports: [{ port: 5433, inventoryEntryId: 'entry-5433' }],
    }),
  ];
  return {
    v: 1,
    machineId: 'machine',
    capturedAtMs: 10_000,
    state: 'live',
    platform: 'darwin',
    evidenceModel: 'tree_and_marker',
    owners,
    leftBehind,
    totals: {
      happier: {
        memoryBytes: happierMemory,
        cpuPercent: happierCpu,
        processCount: owners.reduce((sum, row) => sum + row.members.length, 0),
      },
      leftBehind: { memoryBytes: 1_400 * MB, cpuPercent: 0.1, processCount: 3 },
    },
    ...overrides,
  };
}

export const PROCESSES_FIXTURE_BYTES = { MB, GB } as const;
