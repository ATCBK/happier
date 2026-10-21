import psList from 'ps-list';

export type ProcessSnapshotEntry = Awaited<ReturnType<typeof psList>>[number];

type ListProcessSnapshotOptions = Readonly<{
  ttlMs?: number;
  nowMs?: () => number;
  psListImpl?: () => Promise<readonly ProcessSnapshotEntry[]>;
}>;

const DEFAULT_PROCESS_SNAPSHOT_TTL_MS = 1_000;

let cachedSnapshot: Readonly<{ capturedAtMs: number; processes: readonly ProcessSnapshotEntry[] }> | null = null;
let inFlightSnapshot: Promise<readonly ProcessSnapshotEntry[]> | null = null;

// ps-list spawns `ps` with the ambient environment (no injection point); under a launchd daemon
// without LANG/LC_* that ps runs in the C locale and M-escapes non-ASCII bytes in captured
// command lines (same root cause as the doctor.ts ps projections). Force a UTF-8 locale around
// the scan and restore the ambient environment afterwards. The single-flight + TTL cache above
// keeps the mutation window to one ps-list pass.
const POSIX_PS_UTF8_LOCALE = 'en_US.UTF-8';

async function psListWithPosixUtf8Locale(): Promise<readonly ProcessSnapshotEntry[]> {
  if (process.platform === 'win32') return psList();
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
  process.env.LANG = POSIX_PS_UTF8_LOCALE;
  process.env.LC_ALL = POSIX_PS_UTF8_LOCALE;
  try {
    return await psList();
  } finally {
    if (saved.LANG === undefined) delete process.env.LANG;
    else process.env.LANG = saved.LANG;
    if (saved.LC_ALL === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = saved.LC_ALL;
  }
}

export async function listProcessSnapshot({
  ttlMs = DEFAULT_PROCESS_SNAPSHOT_TTL_MS,
  nowMs = Date.now,
  psListImpl = psListWithPosixUtf8Locale,
}: ListProcessSnapshotOptions = {}): Promise<readonly ProcessSnapshotEntry[]> {
  const ttl = Math.max(0, Math.floor(ttlMs));
  const now = nowMs();

  if (ttl > 0 && cachedSnapshot && now - cachedSnapshot.capturedAtMs <= ttl) {
    return cachedSnapshot.processes;
  }

  if (inFlightSnapshot) {
    return await inFlightSnapshot;
  }

  const snapshot = Promise.resolve()
    .then(() => psListImpl())
    .then((processes) => {
      const capturedAtMs = nowMs();
      cachedSnapshot = { capturedAtMs, processes };
      return processes;
    });

  inFlightSnapshot = snapshot;
  try {
    return await snapshot;
  } finally {
    if (inFlightSnapshot === snapshot) {
      inFlightSnapshot = null;
    }
  }
}

export function clearProcessSnapshotCacheForTests(): void {
  cachedSnapshot = null;
  inFlightSnapshot = null;
}
