import { config } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

// Home uses Mini schemas but keeps Classic's English error messages.
config(en());
