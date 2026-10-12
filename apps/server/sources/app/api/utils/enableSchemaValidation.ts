import type { FastifyBaseLogger, FastifyInstance, RawReplyDefaultExpression, RawRequestDefaultExpression, RawServerDefault } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { deferZodSchemaForParser } from '@happier-dev/protocol/lazyZodSchema';

/** Configure the API's native Zod request and response admission. */
export function enableSchemaValidation<Logger extends FastifyBaseLogger>(app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression<RawServerDefault>,
    RawReplyDefaultExpression<RawServerDefault>,
    Logger
>): void {
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('onRoute', route => {
        const schema = route.schema;
        if (!schema) return;
        // Fastify probes Fluent markers/prototypes while normalizing routes.
        // Its native lazy schema is the framework handle; the original shared
        // definition is resolved only by actual parsing or explicit projection.
        for (const key of ['body', 'params', 'querystring', 'query', 'headers']) {
            const value: unknown = Reflect.get(schema, key);
            if (value !== undefined) Reflect.set(schema, key, deferZodSchemaForParser(value));
        }
        if (schema.response) {
            schema.response = Object.fromEntries<unknown>(Object.entries(schema.response)
                .map(([status, value]) => [status, deferZodSchemaForParser(value)]));
        }
    });
}
