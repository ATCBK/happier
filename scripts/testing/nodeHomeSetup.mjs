import { installTestHomeEnvironment } from './testHomeEnvironment.mjs';

// Node executes --import before any native test module's static dependencies.
// The canonical temporary-directory owner performs process-exit cleanup.
installTestHomeEnvironment();
