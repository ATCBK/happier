import { config } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

// SDK-hosted guests and the build CLI start independently of app bootstraps.
config(en());
