import { SESSION_NESTED_SUBCOMMAND_HELP_LINES, SESSION_SUBCOMMAND_HELP_LINES, SESSION_TOP_LEVEL_HELP_LINES } from './shared/sessionCommandUsage';
import { emitSessionHelp, inferSessionKind } from './shared/sessionHelpOutput';
import { wantsJson } from '@/cli/output/jsonEnvelope';
import { printPublishedActionCliHelp } from '@/cli/actions/publishedHelp';

export function normalizeHelpSubcommand(value: string): string {
  return value === 'voice_agent' ? 'voice-agent' : value;
}

export function isHelpToken(value: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

export async function buildSessionTopLevelHelpLines(): Promise<readonly string[]> {
  const { listPublishedActionCliUsageLinesForRoot: listCompiledActionCliUsageLinesForRoot } = await import('@/cli/actions/publishedHelp');
  return [...SESSION_TOP_LEVEL_HELP_LINES, ...listCompiledActionCliUsageLinesForRoot(['session'])];
}

export async function readCompiledSessionSubcommandHelp(
  subcommand: string,
): Promise<readonly string[] | null> {
  const { listPublishedActionCliUsageLinesForRoot: listCompiledActionCliUsageLinesForRoot } = await import('@/cli/actions/publishedHelp');
  const rows = listCompiledActionCliUsageLinesForRoot(['session', subcommand]);
  return rows.length > 0 ? rows : null;
}

export function readSessionSubcommandHelp(argv: readonly string[]): readonly string[] | string | null {
  const subcommand = normalizeHelpSubcommand(String(argv[0] ?? '').trim());
  if (!subcommand) return null;

  const nestedSubcommand = normalizeHelpSubcommand(String(argv[1] ?? '').trim());
  if (nestedSubcommand && !isHelpToken(nestedSubcommand)) {
    const nestedHelp = SESSION_NESTED_SUBCOMMAND_HELP_LINES[`${subcommand} ${nestedSubcommand}`];
    if (nestedHelp) return nestedHelp;
  }

  return SESSION_SUBCOMMAND_HELP_LINES[subcommand] ?? null;
}

export async function printSessionFamilyHelp(args: readonly string[]): Promise<void> {
  const argv = args.slice(1);
  const subcommand = String(argv[0] ?? '').trim();
  const json = wantsJson(argv);
  if (!subcommand || isHelpToken(subcommand)) {
    await emitSessionHelp({ help: await buildSessionTopLevelHelpLines(), json, kind: 'session_help' });
    return;
  }
  if (await printPublishedActionCliHelp(['session', ...argv], { exactOnly: true })) return;
  const dedicatedHelp = readSessionSubcommandHelp(argv);
  const compiledHelp = await readCompiledSessionSubcommandHelp(normalizeHelpSubcommand(subcommand));
  const rows = [...(dedicatedHelp === null ? [] : typeof dedicatedHelp === 'string' ? [dedicatedHelp] : dedicatedHelp), ...(compiledHelp ?? [])];
  await emitSessionHelp({ help: rows.length > 0 ? rows : await buildSessionTopLevelHelpLines(), json, kind: inferSessionKind(argv) });
}

