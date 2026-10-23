import { listRootHelpCommands } from './commandSurfaceManifest';
import { renderRootHelpText } from './rootHelpText';

export function buildRootHelpText(): string {
  return renderRootHelpText(listRootHelpCommands());
}
