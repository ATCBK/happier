import { renderPublishedActionCliRootHelp } from '@/cli/actions/publishedHelp';

export function printBrowserFamilyHelp(args: readonly string[]): void {
  if (args[1] === 'help' && !args.includes('--help') && !args.includes('-h')) console.log(renderPublishedActionCliRootHelp('browser'));
  else if (args[1] === 'sandbox') printBrowserSandboxHelp();
  else printBrowserHelp();
}

export function printBrowserHelp(): void {
  console.log(`${renderPublishedActionCliRootHelp('browser')}\n  happier browser sandbox install [--print]\n    Allow the managed Chromium executable to use its Linux sandbox (sudo).`);
}

export function printBrowserSandboxHelp(): void {
  console.log('happier browser sandbox install [--print]\nInstalls an executable-scoped AppArmor userns profile with one sudo action. --print displays the profile without applying it.');
}
