import { installTestHomeEnvironment } from './testHomeEnvironment.mjs';

const home = installTestHomeEnvironment();

// Import the runner only after Home isolation, including its dependency graph.
const { afterAll } = await import('vitest');
afterAll(home.cleanup);
