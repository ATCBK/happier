# 平台覆盖清单（OVERLAY-REGISTRY）—— 影响分析中枢

> 由 [DEV-SPEC.md](DEV-SPEC.md) §三定义。feat 合入 master 的同一 commit 必须更新本表。
> 机械校验：`node scripts/platform/overlay-check.mjs`（必须 0 drift）。
> 状态机：active → pending-pr → accepted-upstream → retired

<!-- dev 基底视图（pr 分支登记载体）：无 feat 标识（registry 本体非 feat 拥有文件） -->
> **dev 基底视图（pr 分支登记载体）**：dev 为上游镜像不携带治理基建（全量 registry/scripts 仅在
> master）。本文件仅登记 dev 树上现存标识的 feat：既有 `recent-paths-curation` 行自 master 全量
> registry 摘录（保证 dev 树 0 drift），新增行状态 `pending-pr`（pr/fix-daemon-ps-locale-encoding
> 开发期登记，DEV-SPEC §六）。dev→master 周同步时本表并入 master 全量 registry（合并取 master
> 全量 + 追加新行）。

## 活动覆盖

| feat-id | 类型 | 状态 | 文件 | 标记 | 说明 |
|---------|------|------|------|------|------|
| recent-paths-curation | extension | active | `docs/platform/recent-paths-curation/**` | @happier-platform:file | recentMachinePaths 生命周期策展调研文档（随 pr/curate-recent-machine-paths 并入 dev；master 侧完整登记见 master registry） |
| recent-paths-curation | extension | active | `apps/ui/sources/utils/sessions/recentMachinePathsCuration.ts` `apps/ui/sources/utils/sessions/recentMachinePathsCuration.test.ts` `apps/ui/sources/sync/engine/sessions/syncSessions.ts` `apps/ui/sources/sync/engine/sessions/syncSessionsDeleteCuration.test.ts` `apps/ui/sources/sync/engine/sessions/socket.ts` `apps/ui/sources/sync/sync.ts` | @happier-platform:begin/end | 核心引擎：home-aware 纯函数 + 删除汇聚点 capture/prune 回调 + socket/sync 布线 |
| recent-paths-curation | extension | active | `apps/ui/sources/components/ui/pathPicker/PathSelectionList.tsx` `apps/ui/sources/components/sessions/new/components/NewSessionPathSelectionContent.tsx` `apps/ui/sources/app/(app)/new/pick/path.tsx` `apps/ui/sources/components/sessions/new/hooks/recentMachinePathsRemoval.ts` `apps/ui/sources/components/sessions/new/hooks/recentMachinePathsRemoval.test.ts` | @happier-platform:begin/end | UI 入口：路径选择器 Recent 行移除附件 |
| recent-paths-curation | extension | active | `apps/ui/sources/text/translations/**` | @happier-platform:begin/end | 12 locale：newSession.pathPicker.removeRecent 键 |
| daemon-ps-locale-fix | extension | pending-pr | `apps/cli/src/daemon/doctor.ts` `apps/cli/src/daemon/doctor.posixProcessDiscovery.test.ts` `apps/cli/src/daemon/processSnapshotCache.ts` `apps/cli/src/daemon/processSnapshotCache.posixLocale.test.ts` | @happier-platform:begin/end | macOS launchd 无 LANG/LC_* → BSD ps C locale 把非 ASCII 路径转义 M-x 记法 → runner 入口身份恒判 stale（手机端"旧版 CLI"横幅永不清除）；修复=daemon 全部三条 ps 通路强制 UTF-8 locale（doctor execFileSync×2 + processSnapshotCache ps-list×1，第二通路 2026-10-21 部署后实测补全；00-branch-process 五步流 pr/fix-daemon-ps-locale-encoding） |
| daemon-ps-locale-fix | extension | pending-pr | `docs/platform/daemon-ps-locale-fix/**` | @happier-platform:file | 根因+证据锚点+修复记录（推送 origin 前按 DEV-SPEC §六剥离） |
