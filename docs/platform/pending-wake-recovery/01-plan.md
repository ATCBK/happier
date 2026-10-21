<!-- @happier-platform:file feat=pending-wake-recovery -->
# pending-wake-recovery — 实施方案（01-plan，2026-10-21 用户批准；同日泳道纠正：落地分支 pr/pending-wake-recovery @ upstream/dev）

## 根因（白盒钉死）

```
服务端 pendingVersion = 每次变更 +1 的全局单调计数器（applyPendingSessionStateChange，DB 持久）
客户端乐观记账 = claim 后本地预测 +1（pendingQueueState derive L92）
     ↓ 任何其他写入方（App 再入队/block/discard）都使预测偏差 → 版本漂移
漂移方向为【本地超前】时：
applyKnownPendingQueueState 原 L54 去重：hint/ack.version < believed → 整个静默丢弃，changed:false
     → 追赶机制（hint/ack 教学）本身被吞 = 死锁 → 唤醒永不发生
叠加 SessionProviderInputConsumer 原 L696：deferred 一律无重试定时器，唤醒纯事件驱动
     → 消费循环永久停摆（僵尸会话；两起实证：luceo 10-20 / 京东云 295759 11.4h）
放大器：debug 级日志被过滤（hint 丢弃不可观测）+ 无看门狗
```

证伪记录：watchdog 设计文档原归因"connection-supervisor 重连监督器永久停摆"不成立（295759 全程 11 次断线均成功 backoff 重连）。

## 修复（Fix1-4，全部落地）

| Fix | 内容 | 锚点 |
|---|---|---|
| 1 | mismatch deferred 携带 retryAfterMs(250ms) + 消费循环 mismatch 有界重入（复用 timedMaterializationRejoin 一次性机制，非轮询） | sessionClient.ts / SessionProviderInputConsumer.ts |
| 2 | 版本回退采纳纠偏（服务端唯一权威公理）+ hint/ack 两路径 info 级漂移纠正日志 | pendingQueueState.ts / sessionClient.ts |
| 3 | 消费等待静默心跳：等待 >15min（HAPPIER_PENDING_INPUT_STALE_RECHECK_MS 可调/0 禁）→ info 日志 + force-reconcile 自检 + 重跑 pass | SessionProviderInputConsumer.ts |
| 4 | 外部文档修正（京东云 watchdog §1.2 证伪改写 + luceo §3.3 三环归因 + merged 报告并入） | 仓库外 |

**明确不做**：服务端 pending-age 重推（客户端自愈后无需求，删除测试通过）；`waiting_for_predecessor`/`waiting_for_foreground_turn` 重试（服务端状态门语义）；自动击杀类看门狗处置（回合超时只观测不自毙）。

**后续项（本 feat 未含）**：回合输出停滞检测、子进程 CPU 采样——需 claude provider 层（runClaude 输出流）接线，独立立项；心跳层已覆盖两起事故的系统性停摆形态。

## 四刻度评估（DEV-SPEC §五.2 单列门）

- 交织：低。触点集中在 pending queue 走廊既有 owner，零新增跨模块耦合；心跳与 Fix1/2 无共享状态。
- 模块深度：修在 canonical owner（版本记账规则/重试语义各一处），非消费端补丁。
- 变更放大：小。无 schema/wire/持久化变更；mixed-version 安全（新客户端 vs 旧服务端）。
- 概念完整性：概念净增仅"静默心跳"一个，由两起复现事故背书（宪法 reproduced-failure 门槛达标）。

## 三视角评估

- 项目本身：全部上游 canonical owner 内最小系统变更；巨石文件（sessionClient.ts）仅返回字段/日志/局部量接线级改动；不触 protocol。
- 业界最佳实践：对齐"server 是单调版本唯一权威（SSOT），客户端缓存不可凌驾服务端证据"公理；丢失唤醒标准解法=事件驱动+兜底自愈+可观测；有界重试+权威纠偏=OCC 冲突恢复标准形态。
- 解耦思想：传输可靠性归监督器（不动）、版本一致性归去重规则（Fix2）、停摆恢复归有界重试+心跳（Fix1/3）——纵深防御，任一层独立生效即可避免僵尸，互不共享状态可独立回滚。

## 验证证据（2026-10-21，worktree 实测）

- RED：ahead-drift 僵尸回归（received=[] 永不送达）+ 回退采纳×2 + 心跳（reconcile 0 次）——全部按预期失败后转绿
- GREEN：durableMutationOutbox 41/41 · pendingQueueState+stateUpdateHandling+rejoin/心跳 16/16 · pendingTurnEndDrain 104/104 · connection-supervisor 44/44 · typecheck 0 错误
