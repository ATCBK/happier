ALTER TABLE "Account" ADD COLUMN "name" TEXT;

-- Match String.trim() for retained profile parts; preserve their original bytes.
WITH whitespace AS (
    SELECT CHAR(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279) AS characters
)
UPDATE "Account"
SET "name" = (
    SELECT NULLIF(TRIM(
        TRIM(COALESCE("Account"."firstName", ''), characters) || ' ' ||
        TRIM(COALESCE("Account"."lastName", ''), characters),
        characters
    ), '')
    FROM whitespace
);
