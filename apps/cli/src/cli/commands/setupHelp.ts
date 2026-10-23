import { cmd, renderHelpPage, type HelpPageOptions } from '@happier-dev/cli-common/output';
import { BUNDLED_CLI_HELP_FACTS } from '@/plugins/projection/registry/sources/generatedBundledCliHelpFacts';

export function printSetupHelp(): void { console.log(renderHelpPage(buildSetupHelpPage(BUNDLED_CLI_HELP_FACTS.setupRecommendedIds))); }

export function buildSetupHelpPage(recommendedProviderIds: readonly string[]): HelpPageOptions {
    const providerExample = recommendedProviderIds.length > 0
        ? `happier setup --home-url https://home.example.test ${recommendedProviderIds.map((id) => `--provider ${id}`).join(' ')}`
        : 'happier setup --home-url https://home.example.test --provider <id>';
    return {
        title: 'setup',
        subtitle: 'Choose or create a Home for this computer',
        usage: [
            {
                label: cmd('happier setup [--home <saved>] [--home-url <https-url>] [--home-descriptor-file <path|->] [--provider <id> ...] [--skip-daemon] [--skip-providers] [--yes|--non-interactive] [--replace-services] [--switch-channel]'),
                description: 'Finds linked Homes, connects to an existing Home, or creates a Personal Home here.',
            },
            {
                label: cmd('happier setup plan [--home <saved>|--home-url <url>|--home-descriptor-file <path|->] [--json]'),
                description: 'Prints the planned steps without running them.',
            },
        ],
        sections: [
            {
                title: 'Examples:',
                rows: [
                    { label: cmd('happier setup --home-url https://home.example.test'), description: '' },
                    { label: cmd('happier setup --home-descriptor-file ./home.json'), description: '' },
                    { label: cmd(providerExample), description: '' },
                    { label: cmd('happier setup plan --home-url https://home.example.test'), description: '' },
                ],
            },
        ],
        notes: [
            'Connects this computer to a Home (Home selection → auth → background service → agents).',
            'With no usable active Home, choose whether to find linked Homes through your sign-in service, connect directly, or create a Personal Home here.',
            'Finding linked Homes is recommended and uses the independently selected sign-in service (Happier Cloud by default).',
            'Pass --home, --home-url, or --home-descriptor-file to connect directly and skip that choice.',
            'A strict descriptor can reach an Iroh-only Home without a public HTTPS address.',
            '--yes adopts an explicitly named Home, then exits incomplete before interactive continuation. --non-interactive changes nothing.',
        ],
    };
}

