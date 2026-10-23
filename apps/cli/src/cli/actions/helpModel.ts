import { renderHelpPage } from '@happier-dev/cli-common/output';

export type ActionCliHelpRow = Readonly<{ label: string; description: string }>;

export type ActionCliHelpModel = Readonly<{
  title: string;
  subtitle: string;
  usage: string;
  positionals: readonly ActionCliHelpRow[];
  options: readonly ActionCliHelpRow[];
  /** CLI-owned flags: routing, output mode and the JSON escape hatches. */
  cliOptions: readonly ActionCliHelpRow[];
  notes: readonly string[];
}>;

export function renderActionCliHelpModel(model: ActionCliHelpModel): string {
  return renderHelpPage({
    title: model.title,
    subtitle: model.subtitle,
    usage: [{ label: model.usage, description: '' }],
    sections: [
      { title: 'Arguments:', rows: [...model.positionals] },
      { title: 'Options:', rows: [...model.options] },
      { title: 'CLI options:', rows: [...model.cliOptions] },
    ],
    notes: [...model.notes],
  });
}

