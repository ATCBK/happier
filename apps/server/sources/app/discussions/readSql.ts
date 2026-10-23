import type { Prisma } from '@prisma/client';
import { getDbProviderFromEnv, prismaRuntime as sql } from '@/storage/prisma';

/** SQL adapters for the existing Discussion readers; values always remain bound. */
export function discussionSqlName(name: string): Prisma.Sql {
    const quote = getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`' : '"';
    return sql.raw(quote + name.replaceAll(quote, quote + quote) + quote);
}

export function discussionJsonText(column: Prisma.Sql, path: readonly string[]): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return sql.sql`json_extract(${column}, ${'$.'.concat(path.join('.'))})`;
    if (provider === 'mysql') return sql.sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${'$.'.concat(path.join('.'))}))`;
    return sql.sql`(${column} #>> ${'{'.concat(path.join(','), '}')}::text[])`;
}

