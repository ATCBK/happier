import { configuration } from './configuration';
import { assertTestHomePath } from '../../../scripts/testing/testHomeEnvironment.mjs';

assertTestHomePath(configuration.happyHomeDir);
