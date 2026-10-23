import { printProvidersHelp } from './providers/help';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { errorFrame } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { tryHandleApprovalRequestCreated } from '@/cli/commands/session/shared/tryHandleApprovalRequestCreated';
import { presentProviderCliRefusal } from '@/providers/lifecycle/presentProviderCliRefusal';
import { executeProvidersCommand, ProviderCliError } from './providers/index';
import { hasFlag } from './providers/args';
import type { resolveProviderCliDependencies } from './providers/deps';



export async function handleProvidersCliCommand(
    context: CommandContext,
    resolveDependencies: typeof resolveProviderCliDependencies = async (options) => (
        await import('./providers/deps')
    ).resolveProviderCliDependencies(options),
): Promise<void> {
    const args = context.args.slice(1);
    const json = hasFlag(args, '--json');
    // `--json` is a machine-output contract: stdout carries the versioned
    // envelope and nothing else. Help is a RESULT of the invocation, so in JSON
    // mode it travels inside that envelope instead of being printed beside it.
    const emitHelp = async (): Promise<void> => printProvidersHelp(json);
    try {
        const subcommand = String(args[0] ?? '').trim();
        if (!subcommand || ['help', '--help', '-h'].includes(subcommand)) {
            await emitHelp();
            return;
        }
        if (['install', 'setup', 'status'].includes(subcommand)) {
            throw new ProviderCliError(
                'legacy_agent_command_moved',
                `Agent setup moved to 'happier agents ${subcommand}'; 'happier providers' now manages model providers`,
            );
        }
        const deps = context.signal ? await resolveDependencies({ signal: context.signal }) : await resolveDependencies();
        const result = await executeProvidersCommand(
            args,
            deps,
            context.signal ? { signal: context.signal } : {},
        );
        if (!result.ok) {
            throw new ProviderCliError(result.error.code, result.error.message, result.error.details);
        }
        if (result.kind === 'providers_help') {
            await emitHelp();
            return;
        }
        if (json) {
            await printJsonEnvelope(result);
            return;
        }
        await writeJsonStdout(result.data, { pretty: true });
    } catch (error) {
        const cliError = error instanceof ProviderCliError
            ? error
            : new ProviderCliError('operation_failed', error instanceof Error ? error.message : 'Unknown provider operation failure');
        if (await tryHandleApprovalRequestCreated({ envelopeKind: `providers_${String(args[0] ?? 'unknown').replaceAll('-', '_')}`,
            json, result: cliError.details })) return;
        if (json) {
            await printJsonEnvelope({
                ok: false,
                kind: `providers_${String(args[0] ?? 'unknown').replaceAll('-', '_')}`,
                error: { code: cliError.code, message: cliError.message, ...(cliError.details === undefined ? {} : { details: cliError.details }) },
            }, { exitCode: 1 });
            return;
        }
        // A typed Provider refusal already names its recovery action. Render it
        // through the canonical presenter so the direct CLI path keeps the same
        // guidance the other Provider surfaces show instead of a bare code.
        const typed = ProviderErrorV1Schema.safeParse(cliError.details);
        console.error(typed.success
            ? errorFrame('The provider refused the request', presentProviderCliRefusal(typed.data))
            : errorFrame(cliError.message));
        process.exitCode = 1;
    }
}
