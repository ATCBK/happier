<!-- @happier-platform:file feat=daemon-ps-locale-fix -->
# daemon ps locale 乱码 → runner 恒判 stale（"旧版 CLI"横幅无法清除）

> pr/fix-daemon-ps-locale-encoding（00-branch-process 五步单向流，DEV-SPEC §六 pr-pending）。
> 推送 origin 前按 §六剥离本目录与 registry 行。

## 根因（已对抗验证 + 本机活体复证 2026-10-21）

macOS 上 daemon 由 launchd 后台服务启动，环境无 `LANG`/`LC_*` → daemon 内
`execFileSync('ps', ...)` 继承 C locale → BSD ps 在 C locale 下把命令行中的非 ASCII
字节改写为 M-x 控制记法：活体实证 `/tmp/项目test/sleep` → `/tmp/M-iM-!M-9M-gM^[M-.test/sleep`
（与本机报告的转义序列逐字节一致）。

后果链：runner 入口身份（ps 捕获，乱码）≠ daemon 当前身份（Node 内正确路径）→
sessionRunnerRuntime 一致性比对恒 false → 恒判 stale → 手机端"旧版 CLI"横幅永久无法清除
（重启运行器成功后再次 ps 捕获再次乱码，死循环）。

## 证据锚点

- `apps/cli/src/daemon/doctor.ts`
  - `getProcessInfoByPidPosix`（原 ~L244）：`ps -o stat=,ucomm=,command= -p <pid>`，
    原先未传 `env`；
  - `readDaemonOwnershipEnvironmentVariablesFromPosixPs`（原 ~L107）：`ps eww -p <pid> -o command=`，
    同样未传 `env`。
- 活体对照（本机 darwin）：
  - `env -u LANG -u LC_ALL ps -o command= -p <pid>` → `M-iM-!M-9M-gM^[M-.` 转义；
  - `env LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ps ...` → `项目` 原样返回。

## 修复

两处 ps 调用统一经新增 `posixPsEnvironment()` 构造子进程 env：
`{ ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }`——无条件强制 UTF-8，
使 ps 输出与宿主环境 locale 解耦（用户机器 locale 差异不再影响捕获字节）。

## 同概念排查（缺陷作搜索键）

grep 全 `apps/cli/src` 的 ps 调用共 3 处：

| 调用点 | 投影 | 处置 |
|---|---|---|
| `doctor.ts` getProcessInfoByPidPosix | `stat=,ucomm=,command=` | 已修（command 含路径，非 ASCII 敏感） |
| `doctor.ts` readDaemonOwnershipEnvironmentVariablesFromPosixPs | `eww ... command=` | 已修（同上，且 env 值本身可含非 ASCII） |
| `daemon/processRunState.ts:52` | `state=` | **豁免**：输出仅单 ASCII 状态字母（S/R/Z/U...），与 locale 无关，修之无缺陷对应 |

## 测试

`doctor.posixProcessDiscovery.test.ts` 新增用例：mock `execFileSync`，经公共边界
`readProcessInfoByPid`（darwin）断言两个 ps 投影的 options 均强制
`LANG`/`LC_ALL=en_US.UTF-8` 且继承宿主 PATH；并保留非 ASCII 路径解析健全性断言。

- RED：`expected undefined to be 'en_US.UTF-8'`（env 缺失，即缺陷本体）
- GREEN：2/2 passed

## 第二通路补全（2026-10-21 部署后实测发现）

首轮修复部署（dev 7a73a75b9 / master 0d5bb0ef8，daemon 重启后）RPC
`/session-runners/status` 仍报 `versionState: stale` 且 `runtimeId` 仍为
`m-im-!m-9m-gm^[m-.` 转义——存在第三条 ps 通路：

- **`daemon/processSnapshotCache.ts` → ps-list 库**：daemon 启动 reattach 扫描
  （`reattachFromMarkers` → `findAllHappyProcesses` → `listProcessSnapshot` → `psList()`）
  是 `tracked.processCommand` 的捕获源；ps-list 内部 `execFile('ps', ...)` 用环境继承
  （无 env 注入口），daemon 无 LANG → C locale 乱码直接进入 tracked 表。
- 活体复证（本机）：`env -u LANG -u LC_ALL ps axo pid,comm,args` → 同一命令行
  `M-iM-!M-9M-gM^[M-.`；`env LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` → `项目` 原样。

### 补全修复

`processSnapshotCache.ts` 默认 `psListImpl` 换为 `psListWithPosixUtf8Locale()`：
posix 下在 ps-list 调用窗口临时置 `process.env.LANG/LC_ALL=en_US.UTF-8`，完成后恢复
原值（含未设置态）；win32 直通。单飞+TTL 缓存保证窗口极短；doctor 两处显式 env 传参
不受影响。**daemon 的全部 ps 子进程（execFileSync×2 + ps-list×1）自此统一 UTF-8。**

### 补全测试

`processSnapshotCache.posixLocale.test.ts`（mock ps-list，经公共边界
`listProcessSnapshot`）：断言扫描窗口内 ps-list 看到 UTF-8 locale、未设置/已设置的
ambient 值均被正确恢复。

- RED：`expected [ { lang: undefined … } ] to deeply equal [ { lang: 'en_US.UTF-8' … } ]`
- GREEN：2/2 passed（连同原 doctor 套件 4/4）
