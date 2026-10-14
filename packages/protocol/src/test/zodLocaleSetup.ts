import { config } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

// Root Vitest workers import Protocol schemas without an application bootstrap.
config(en());
