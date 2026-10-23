import type { Prisma } from '@prisma/client';
import { getDbProviderFromEnv, prismaRuntime as sql } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';

/** SQL adapters for the existing Discussion readers; values always remain bound. */
export function discussionSqlName(name: string): Prisma.Sql {
    const quote = getDbProviderFromEnv(process.env, 'postgres') === 'mysql' ? '`' : '"';
    return sql.raw(quote + name.replaceAll(quote, quote + quote) + quote);
}

/** Match Prisma's UTC wall-time DateTime columns, independent of session TimeZone. */
export function discussionSqlTimestamp(at: Date): Prisma.Sql {
    const provider = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (provider === 'sqlite') return sql.sql`${at.getTime()}`;
    // Raw Date parameters are timestamptz on PostgreSQL. Casting that Date to
    // timestamp would first shift it into the session zone; bind UTC text instead.
    if (provider === 'postgres') return sql.sql`${at.toISOString()}::timestamp`;
    return sql.sql`${at}`;
}

export function discussionJsonText(column: Prisma.Sql, path: readonly string[]): Prisma.Sql {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    if (provider === 'sqlite') return sql.sql`json_extract(${column}, ${'$.'.concat(path.join('.'))})`;
    if (provider === 'mysql') return sql.sql`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${'$.'.concat(path.join('.'))}))`;
    return sql.sql`(${column} #>> ${'{'.concat(path.join(','), '}')}::text[])`;
}

