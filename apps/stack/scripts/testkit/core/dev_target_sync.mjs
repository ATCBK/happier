// Mutagen is an external process boundary. These fixtures use its public
// sync-list model so source admission and readiness parsing remain real.
export function readyDevTargetSyncResult(sessionName = 'happier-linux') {
  return { ok: true, exitCode: 0, out: JSON.stringify([{
    name: sessionName, paused: false, status: 'watching', successfulCycles: 3,
    alpha: { connected: true, scanned: true }, beta: { connected: true, scanned: true },
  }]), err: '' };
}

export function captureDevTargetSyncFixture(command, args) {
  if (command !== 'mutagen' && !args.includes('mutagen')) return null;
  const index = args.indexOf('sync');
  if (index < 0) return null;
  if (args[index + 1] === 'list') return readyDevTargetSyncResult(args[index + 2]);
  if (args[index + 1] === 'flush') return { ok: true, exitCode: 0, out: '', err: '' };
  return null;
}
