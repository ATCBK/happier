ALTER TABLE "Account" ADD COLUMN "name" TEXT;

-- Match String.trim() for retained profile parts; preserve their original bytes.
WITH whitespace AS (
    SELECT U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' AS characters
)
UPDATE "Account"
SET "name" = NULLIF(CONCAT_WS(' ',
    NULLIF(BTRIM(COALESCE("firstName", ''), whitespace.characters), ''),
    NULLIF(BTRIM(COALESCE("lastName", ''), whitespace.characters), '')
), '')
FROM whitespace;
