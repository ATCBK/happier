import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';

// The Codex native app-server is a spawned provider process reached over JSON-RPC:
// a genuine system boundary. Its default `thread/list` returns interactive
// sources only, so it contributes no internal threads here; rollout discovery,
// classification and paging below stay the real implementation.
vi.mock('../../../runtime/appServer/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../runtime/appServer/client.js')>();
  return {
    ...actual,
    createCodexNativeAppServerClient: async () => ({
      launchFeatures: { realtimeConversationAdvertised: false },
      request: async () => ({ data: [], nextCursor: null }),
      notify: async () => {},
      registerRequestHandler: () => () => {},
      registerNotificationHandler: () => () => {},
      onExit: () => () => {},
      dispose: async () => {},
    }),
  };
});

import { listCodexSessionCandidates } from './candidateSource.js';
import { projectCodexExternalSessionCandidateToAgent } from './models.js';
import { classifyCodexSessionThread } from '../../../rollout/discovery/sessionThread.js';

const PARENT_ID = '01a0a440-014e-7cd3-9e34-2d7734db5d68';
const SPAWN_PARENT_ID = '01a0e350-4975-7bf3-b0c3-39da228641e2';
const TOP_LEVEL_IDS = [
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333',
];
const REVIEWER_ID = '44444444-4444-4444-4444-444444444444';
const SUBAGENT_ID = '55555555-5555-5555-5555-555555555555';

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

// Real session_meta shapes observed in Codex 0.157 rollouts.
const META_BY_ID: Readonly<Record<string, Record<string, unknown>>> = {
  [TOP_LEVEL_IDS[0]!]: { source: 'vscode' },
  [TOP_LEVEL_IDS[1]!]: { source: 'cli' },
  [TOP_LEVEL_IDS[2]!]: {},
  [REVIEWER_ID]: {
    source: { subagent: { other: 'guardian' } },
    thread_source: 'guardian_review',
    parent_thread_id: PARENT_ID,
  },
  [SUBAGENT_ID]: {
    source: {
      subagent: {
        thread_spawn: {
          parent_thread_id: SPAWN_PARENT_ID,
          depth: 1,
          agent_path: '/root/audit',
          agent_nickname: 'Euclid',
          agent_role: 'explorer',
        },
      },
    },
    thread_source: 'subagent',
    parent_thread_id: SPAWN_PARENT_ID,
  },
};

async function writeCorpus(root: string): Promise<string> {
  const codexHome = join(root, 'codex-home');
  const sessionsDir = join(codexHome, 'sessions', '2026', '09', '26');
  await mkdir(sessionsDir, { recursive: true });
  // The process fixture above represents an available native server. Mirror
  // its control-path presence without launching a vendor process.
  await mkdir(join(codexHome, 'app-server-control'));
  await writeFile(join(codexHome, 'app-server-control', 'app-server-control.sock'), '');
  // Threads interleave with top-level sessions in both traversal and activity order.
  const ordered = [TOP_LEVEL_IDS[0]!, REVIEWER_ID, TOP_LEVEL_IDS[1]!, SUBAGENT_ID, TOP_LEVEL_IDS[2]!];
  for (const [index, id] of ordered.entries()) {
    const filePath = join(sessionsDir, `rollout-2026-09-26T10-0${9 - index}-00-${id}.jsonl`);
    await writeFile(
      filePath,
      jsonl({
        type: 'session_meta',
        timestamp: '2026-09-26T10:00:00.000Z',
        payload: { id, timestamp: '2026-09-26T10:00:00.000Z', cwd: '/repo', ...META_BY_ID[id] },
      })
      + jsonl({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${id.slice(0, 4)}` }] },
      }),
      'utf8',
    );
    const mtime = new Date(Date.parse('2026-09-26T12:00:00.000Z') - index * 60_000);
    await utimes(filePath, mtime, mtime);
  }
  return codexHome;
}

async function drain(params: Readonly<{
  root: string;
  codexHome: string;
  searchTerm?: string;
  includeThreads?: boolean;
}>) {
  const drained: Awaited<ReturnType<typeof listCodexSessionCandidates>>['candidates'] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await listCodexSessionCandidates({
      source: { kind: 'codexHome', home: 'user' },
      activeServerDir: join(params.root, 'active-server'),
      env: { CODEX_HOME: params.codexHome } as NodeJS.ProcessEnv,
      exec: {
        systemTools: { resolve: async () => ({ executable: { kind: 'path', path: '/usr/bin/codex' } }) },
      } as unknown as ExecService,
      limit: 2,
      searchMode: 'full',
      ...(params.searchTerm ? { searchTerm: params.searchTerm } : {}),
      ...(params.includeThreads !== undefined ? { includeThreads: params.includeThreads } : {}),
      ...(cursor ? { cursor } : {}),
    });
    drained.push(...result.candidates);
    if (!result.nextCursor) return drained;
    cursor = result.nextCursor;
  }
  throw new Error('candidate listing did not terminate');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Codex internal-thread classification', () => {
  it('classifies approval reviewers and spawned sub-agents from session_meta, top-level otherwise', () => {
    expect(classifyCodexSessionThread(META_BY_ID[REVIEWER_ID])).toEqual({
      kind: 'reviewer',
      parentRemoteSessionId: PARENT_ID,
    });
    // `thread_source` alone still marks a reviewer when `source` is absent.
    expect(classifyCodexSessionThread({ thread_source: 'guardian_review' })).toEqual({
      kind: 'reviewer',
      parentRemoteSessionId: null,
    });
    // The spawn record carries the parent even when the top-level field is absent.
    expect(classifyCodexSessionThread({
      source: { subagent: { thread_spawn: { parent_thread_id: SPAWN_PARENT_ID, depth: 1 } } },
    })).toEqual({ kind: 'subagent', parentRemoteSessionId: SPAWN_PARENT_ID });
    expect(classifyCodexSessionThread({ source: { subagent: 'compact' } })).toEqual({
      kind: 'subagent',
      parentRemoteSessionId: null,
    });
    expect(classifyCodexSessionThread({ source: 'vscode' })).toBeNull();
    expect(classifyCodexSessionThread({ source: { custom: 'ide' } })).toBeNull();
    expect(classifyCodexSessionThread(null)).toBeNull();
  });
});

describe('Codex candidate listing internal threads', () => {
  it.each([
    ['unsearched index-build chunks', undefined],
    ['the searched merged ordering', '/repo'],
  ])('excludes internal threads by default and reveals them on request (%s)', async (_label, searchTerm) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-codex-candidate-threads-'));
    try {
      const codexHome = await writeCorpus(root);

      const defaults = await drain({ root, codexHome, searchTerm });
      expect(defaults.map((candidate) => candidate.remoteSessionId).sort()).toEqual([...TOP_LEVEL_IDS].sort());
      expect(defaults.every((candidate) => candidate.thread === undefined)).toBe(true);

      const revealed = await drain({ root, codexHome, searchTerm, includeThreads: true });
      expect(revealed.map((candidate) => candidate.remoteSessionId).sort()).toEqual(
        [...TOP_LEVEL_IDS, REVIEWER_ID, SUBAGENT_ID].sort(),
      );
      const byId = new Map(revealed.map((candidate) => [candidate.remoteSessionId, candidate] as const));
      expect(byId.get(REVIEWER_ID)?.thread).toEqual({ kind: 'reviewer', parentRemoteSessionId: PARENT_ID });
      expect(byId.get(SUBAGENT_ID)?.thread).toEqual({ kind: 'subagent', parentRemoteSessionId: SPAWN_PARENT_ID });
      expect(byId.get(TOP_LEVEL_IDS[0]!)?.thread).toBeUndefined();

      expect(projectCodexExternalSessionCandidateToAgent(byId.get(REVIEWER_ID)!).thread).toEqual({
        kind: 'reviewer',
        parentRemoteSessionId: PARENT_ID,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
