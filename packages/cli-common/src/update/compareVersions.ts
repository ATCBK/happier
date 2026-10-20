export function compareVersions(a: string, b: string): number {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();

  type Parsed = {
    major: number;
    minor: number;
    patch: number;
    prerelease: Array<string | number>;
  };

  const parse = (raw: string): Parsed | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+.*)?$/.exec(raw);
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
    const preRaw = String(m[4] ?? '').trim();
    const prerelease = preRaw
      ? preRaw.split('.').filter(Boolean).map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : [];
    return { major, minor, patch, prerelease };
  };

  const pa = parse(sa);
  const pb = parse(sb);
  if (!pa || !pb) return sa.localeCompare(sb);

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // release > prerelease
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai == null && bi == null) return 0;
    if (ai == null) return -1; // shorter prerelease has lower precedence
    if (bi == null) return 1;

    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && bNum) {
      if (ai !== bi) return ai > bi ? 1 : -1;
      continue;
    }
    if (aNum && !bNum) return -1; // numeric < non-numeric
    if (!aNum && bNum) return 1;

    const as = String(ai);
    const bs = String(bi);
    if (as === bs) continue;
    return as.localeCompare(bs);
  }

  return 0;
}
