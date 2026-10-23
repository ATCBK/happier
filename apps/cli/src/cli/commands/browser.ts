import type { CommandContext } from '@/cli/commandRegistry';
import { printBrowserHelp, printBrowserSandboxHelp } from './browserHelp';
import { handleActionCliRootCommand, renderActionCliRootHelp } from '@/cli/actions/rootCommand';
import { resolveManagedBrowserSidecarCandidate } from '@/daemon/browser/sidecar/source';
import { installManagedChromiumSandbox, managedChromiumAppArmorProfile } from '@/daemon/browser/sidecar/sandbox';

/** Explicit local OS prerequisite installation; delegates artifact acquisition to the managed owner. */
export async function handleBrowserCliCommand(context: CommandContext): Promise<void> {
    const args = context.args.slice(1);
    if (args[0] !== 'sandbox') {
        if (!args.length || args.includes('--help') || args.includes('-h')) {
            printBrowserHelp();
            return;
        }
        return handleActionCliRootCommand('browser', context);
    }
    if (args.includes('--help') || args.includes('-h')) {
        printBrowserSandboxHelp();
        return;
    }
    if (args[1] !== 'install' || args.slice(2).some(arg => arg !== '--print')) {
        throw new Error('Usage: happier browser sandbox install [--print]');
    }
    if (process.platform !== 'linux') throw new Error('Browser sandbox profile installation applies only to Linux with AppArmor.');
    if (args.includes('--print')) {
        const candidate = await resolveManagedBrowserSidecarCandidate();
        if (!candidate?.available || !candidate.executablePath) throw new Error('Managed Chromium is not installed. Open an agent browser first, then run this command.');
        console.log(managedChromiumAppArmorProfile(candidate.executablePath).content);
        return;
    }
    const installed = await installManagedChromiumSandbox();
    if (installed.status === 'failed') throw new Error(`Browser sandbox installation failed: ${installed.code}`);
    console.log('Managed Chromium sandbox profile installed. Retry the browser action.');
}
