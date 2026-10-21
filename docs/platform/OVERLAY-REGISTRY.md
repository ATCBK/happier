# 平台覆盖清单（OVERLAY-REGISTRY）—— pr/pending-wake-recovery 分支内登记

> **本文件为 pr 分支分支内登记**（DEV-SPEC §六：pr 分支开发期 registry 登记，type=pr-pending）。
> 本分支基底 = `upstream/dev`（纯上游，无平台层），master 的正式 registry 不在本分支上；
> **master 直合验收时**由合并者将下表 6 行并轨进 master 侧 `docs/platform/OVERLAY-REGISTRY.md`（状态保持 pr-pending；官方接受后按 §四.3 转 retired）。
> **推送 origin 前**按 §六 strip：本文件与 `docs/platform/pending-wake-recovery/**` 一并移除，PR 交付物只含上游规范内容。

## pr-pending 登记（2026-10-21 泳道纠正：自 feat/platform-pending-wake-recovery 迁移，基底由 master 改为 upstream/dev）

| feat-id | 类型 | 状态 | 文件 | 标记 | 说明 |
|---------|------|------|------|------|------|
| pending-wake-recovery | extension | pr-pending | `docs/platform/pending-wake-recovery/**` | @happier-platform:file | 方案（四刻度+三视角评估）+审查清单；两起"在线不收消息"事故白盒取证（luceo 10-20 + 京东云 runner 295759 僵尸 11.4h），根因三环：pendingVersion 记账漂移→版本去重吞 hint（死锁）→deferred mismatch 无重试无兜底 |
| pending-wake-recovery | extension | pr-pending | `apps/cli/src/api/session/pendingQueueState.ts` | @happier-platform:begin/end | 核心修复①：版本回退的权威状态采纳纠偏（原"低于本地版本即丢弃"=丢失唤醒死锁根因；服务端 pendingVersion 单调唯一权威） |
| pending-wake-recovery | extension | pr-pending | `apps/cli/src/api/session/sessionClient.ts` | @happier-platform:begin/end | 修复②③：mismatch deferred 携带 retryAfterMs（250ms 有界重入）+ hint/ack 两路径版本回退纠偏 info 级日志（可观测性） |
| pending-wake-recovery | extension | pr-pending | `apps/cli/src/agent/runtime/sessionInput/SessionProviderInputConsumer.ts` | @happier-platform:begin/end | 修复②④：mismatch 有界重入生效（复用 timedMaterializationRejoin 一次性机制）+ 消费等待静默心跳自检（默认 15min force-reconcile 兜底，HAPPIER_PENDING_INPUT_STALE_RECHECK_MS 可调/0 禁用） |
| pending-wake-recovery | extension | pr-pending | `apps/cli/src/api/session/pendingQueueState.test.ts` `apps/cli/src/api/session/sessionStateUpdateHandling.test.ts` `apps/cli/src/api/session/sessionClient.durableMutationOutbox.test.ts` | @happier-platform:begin/end | RED/GREEN：回退采纳×2 + ahead-drift 僵尸回归（hint 教高版本→mismatch 教低版本被吞→停摆；修复后经纠偏唤醒恢复） |
| pending-wake-recovery | extension | pr-pending | `apps/cli/src/agent/runtime/sessionInput/SessionProviderInputConsumer.pendingMismatchRejoin.test.ts` | @happier-platform:file | RED/GREEN：mismatch 有界重入（无唤醒事件恢复+一次性非轮询断言）+ 静默心跳（force-reconcile+重跑 materialize+日志） |
