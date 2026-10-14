import { config } from 'zod/mini';
import en from 'zod/v4/locales/en.js';

// Mini omits Classic's automatic English messages. Install them before any
// command, daemon, plugin-host, or runner schema can parse input.
config(en());
