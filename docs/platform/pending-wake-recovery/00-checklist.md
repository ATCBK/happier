<!-- @happier-platform:file feat=pending-wake-recovery -->
# pending-wake-recovery — 审查测试清单（00-checklist）

> feat-id: `pending-wake-recovery` · 分支 `pr/pending-wake-recovery`（from upstream/dev，worktree；2026-10-21 泳道纠正迁移——上游 bug base 走 pr 泳道）
> 根因档案：luceo `.diag/HAPPIER-BUG-luceo-session-no-reply-20261020.md` + 京东云 runner 295759 僵尸（11.4h）
> 状态图例：☐ 待办 · 🟥 RED · 🟩 GREEN · ✅ 通过终审 · ⏸️ 后续项

## Fix 1 — pending_version_mismatch 有界重试

- [x] 🟥 RED：durableMutationOutbox ahead-drift 变体——mismatch 后无第二条 hint，`received=[]` 永不送达（ Matcher did not succeed in time，2026-10-21 实测）
- [x] 🟩 GREEN：sessionClient mismatch 分支携带 retryAfterMs(250ms)；InputConsumer mismatch deferred 有界重入（复用 timedMaterializationRejoin）
- [x] 回归：既有 versionMismatch 用例（带第二条 hint）通过；durableMutationOutbox 全文件 41/41
- [x] 回归：retryable_transport 有界重入语义不变（timedMaterializationRejoinConsumed 仍一次性——rejoin 单测含二次断言）
- [x] waiting_for_predecessor / waiting_for_foreground_turn 未加重试（服务端状态门语义保持）

## Fix 2 — hint 去重语义修正（版本回退=漂移证据→纠偏+唤醒）

- [x] 🟥 RED：pendingQueueState 单测（回退采纳断言失败，2026-10-21 实测 2 failed）
- [x] 🟥 RED：sessionStateUpdateHandling 回退 hint wakeSeq+1 断言失败
- [x] 🟩 GREEN：applyKnownPendingQueueState 删除"低于本地版本即丢弃"分支，采纳服务端权威状态
- [x] 🟩 GREEN：sessionClient applyPendingQueueState + hint 路径两处 info 级漂移纠正日志
- [x] 等值版本去重（防重放）语义不变（same-version replay 用例通过）
- [x] 版本前进路径零变化（durableMutationOutbox 41/41 + pendingTurnEndDrain 104/104）

## Fix 3 — runner 看门狗

- [x] 🟥→🟩 消费循环心跳：waitForNextInput 等待静默 >阈值（默认 15min，HAPPIER_PENDING_INPUT_STALE_RECHECK_MS）→ info 事件 + force-reconcile + 重跑 pass（RED：reconcile 0 次 → GREEN：≥1 次 + materialize 重跑 + 日志断言）
- [ ] ⏸️ 回合输出停滞检测（provider 交付后 N 分钟无输出事件）——**后续项**：需 claude provider 层（runClaude 输出流）接线，独立立项；心跳层已覆盖两起事故的系统性停摆形态
- [ ] ⏸️ 子进程 CPU 采样（空闲态持续高 CPU）——**后续项**：同上，跨平台 ps 实现独立立项（luceo §8 实现锚点已归档）
- [x] 处置仅观测+reconcile 自检，无自动 kill；阈值来源=事故证据（91min 静默/11.4h 僵尸）

## Fix 4 — 外部文档修正（非仓库文件，已完成）

- [x] 京东云 /root/HAPPY-WATCHDOG-设计文档.md 追加 §五根因修正（证伪监督器归因 + 三环链 + 部署脚本旧版紧急提醒）
- [x] luceo .diag 报告追加 §9 归因修正（三环链精化）
- [x] 工作区 logs/HAPPIER-UPSTREAM-ISSUE-merged.md 并入缺陷族结论

## 收尾（六步门 4-6）

- [x] 全部标识就位：代码 3 文件 6 标识块 + 测试 4 文件 + docs 2 文件（:file 标识）
- [x] `yarn workspace @happier-dev/cli typecheck` 通过（exit 0，0 错误）
- [x] 回归切片：pendingTurnEndDrain 104/104 + connection-supervisor 44/44（零触碰确认）
- [x] `node scripts/platform/overlay-check.mjs` → ✓ 0 drift（147 标识点/18 feat/registry 21 项）
- [x] OVERLAY-REGISTRY.md 登记 6 行（分支内 pr-pending 形态；master 直合时并轨进 master 侧 registry）
- [x] fresh reviewer 终审签章：**APPROVE-with-findings**（2026-10-21 独立 Explore agent，30 次工具调用复核）——零阻塞；#1 timer 残留/#2 测试窗口观察两 Low 项已修复复验（typecheck 0 错+2/2+0 drift），#3 迟到回退瞬态为设计内已接受权衡（自愈完整，代价≤1 次多余 claim，info 日志可观测）
- [ ] 过程文档（本清单+01-plan 已就位；合入后按 §五.6 收档）
- [ ] 合入 master：待用户验收裁决（Web 验收门对 CLI 侧修复的适用性见最终报告）
