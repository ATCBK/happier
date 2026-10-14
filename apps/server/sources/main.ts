import './configureZodLocale';
import 'reflect-metadata';
import { runFullServerMain } from '@/flavors/full/main';

void runFullServerMain()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    // A one-shot operator command reports its refusal through `process.exitCode`
    // so a script cannot read "this Home already has an owner" as success.
    .then(() => {
        process.exit(process.exitCode ?? 0);
    });
