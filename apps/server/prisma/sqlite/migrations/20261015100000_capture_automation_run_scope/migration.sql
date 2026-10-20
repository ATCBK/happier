-- Historical scope cannot be reconstructed from mutable Automation definitions.
ALTER TABLE "AutomationRun" ADD COLUMN "automationScopeCaptured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutomationRun" ADD COLUMN "automationScopeSessionId" TEXT;
