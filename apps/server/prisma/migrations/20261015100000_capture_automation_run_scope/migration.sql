-- Historical scope cannot be reconstructed from mutable Automation definitions.
ALTER TABLE "AutomationRun"
    ADD COLUMN "automationScopeCaptured" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "automationScopeSessionId" TEXT;
