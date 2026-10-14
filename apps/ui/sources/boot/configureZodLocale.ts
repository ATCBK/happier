import { config } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

// Configure before Router, sync, or native headless modules parse Mini schemas.
config(en());
