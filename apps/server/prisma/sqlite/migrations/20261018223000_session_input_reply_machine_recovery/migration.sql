ALTER TABLE "SessionMessage" ADD COLUMN "replyTargetMachineId" TEXT;
ALTER TABLE "SessionPendingMessage" ADD COLUMN "replyTargetMachineId" TEXT;
UPDATE "SessionMessage" SET "replyTargetMachineId" = json_extract("inputAdmissionReceipt", '$.admittedTarget.machineId')
WHERE "replyProgress" IS NOT NULL AND json_extract("inputAdmissionReceipt", '$.issuer') = 'authenticatedMachine';
UPDATE "SessionPendingMessage" SET "replyTargetMachineId" = json_extract("inputAdmissionReceipt", '$.admittedTarget.machineId')
WHERE "replyProgress" IS NOT NULL AND json_extract("inputAdmissionReceipt", '$.issuer') = 'authenticatedMachine';
CREATE INDEX "SessionMessage_reply_machine_idx" ON "SessionMessage"("replyTargetMachineId", "replyDisposition", "sessionId", "localId");
CREATE INDEX "SessionPendingMessage_reply_machine_idx" ON "SessionPendingMessage"("replyTargetMachineId", "replyDisposition", "sessionId", "localId");
