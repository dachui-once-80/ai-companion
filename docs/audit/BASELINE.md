# 基线审计（2026-10-15 历史快照）

本文记录 **2026-10-15** 对当时工作区做的只读基线审计，**不是** HEAD `3e9dd05` 的完整现状说明书。
后续已提交的修正见文末「后续已提交修正」；对照当前源码时，以该节与 Git 历史为准，不要把下面「审计当日」段落里的命令结果或文件状态当成此刻仍成立。

审计当日范围：只读源码与可执行命令，不改业务代码。仓库是 pnpm workspace（`pnpm-workspace.yaml` 只包含 `apps/*`）。当时没有根 README，没有 `.env.example`。`apps/web/README.md` 仍是 Vite 模板说明，没有产品行为。

## 目录（审计当日）

| 路径 | 作用（审计当日描述） |
| --- | --- |
| `apps/web` | React 19 + Vite 8 前端。语音会话、见面页、记忆面板、上次对话页。 |
| `apps/server` | Express 5 + better-sqlite3。Gemini、记忆、情绪、待办、WebSocket 代理。 |
| `apps/server/src/db` | Drizzle schema 与 SQLite 连接。库文件默认 `apps/server/companion.db`。 |
| `apps/server/drizzle` | SQL 迁移 `0000`–`0009`。当时 `meta` 快照只到 `0008`（缺 `0009_snapshot.json`）。 |
| `apps/server/src/scripts` | 手写断言脚本；审计当日多数未挂到根或 server 的聚合检查命令。 |
| `apps/web/scripts/presence.check.ts` | 在场决策断言；审计当日未挂到 `package.json`。 |

审计当日没有 `*.test.ts`、`*.spec.ts`、Vitest、Jest 或 Playwright 配置。
（HEAD `3e9dd05` 仍无这类框架配置；离线/竞态检查以手写 `*.check.ts` + `tsx` 为主，见「后续已提交修正」。）

## 环境变量

只在 `apps/server` 读取，没有示例文件。`apps/server/.env` 被 `.gitignore` 忽略。**本文档不记录、不复述其中任何密钥或具体取值。**

| 变量 | 读取位置 | 缺省 |
| --- | --- | --- |
| `GEMINI_API_KEY` | `apps/server/src/index.ts` 启动时必填；若干 live 检查脚本 | 缺失则进程抛错退出 |
| `TAVILY_API_KEY` | `GET /api/search` | 缺失时该接口返回 500 |
| `HTTP_PROXY` / `HTTPS_PROXY` / `PROXY_URL` | `apps/server/src/index.ts` | 未设置时用 `http://127.0.0.1:1082`；值为 `off` 或 `false` 时直连 |
| `COMPANION_DB` | `apps/server/src/db/index.ts` | `companion.db`（相对 server 进程工作目录） |

源码中另有被注释的 `OPENAI_API_KEY` 字样；全库应用代码没有读取它。

前端不持有模型密钥。浏览器向 `POST /api/gemini/token` 要一次性 token，再经 `/api/gemini/live-proxy` 连 Gemini Live。

## 命令结果（仅 2026-10-15 审计当日）

以下结果只描述审计当日在本机执行的情况。Node v22.14.0，包管理器 `pnpm@10.33.0`。依赖当时已安装。
**本次文档修订（对照 HEAD `3e9dd05`）未重新执行下表命令；不要当作当前 CI 或工作树结果。**

| 命令 | 审计当日结果 |
| --- | --- |
| `pnpm --filter web exec tsc -b --pretty false` | 通过。无诊断。 |
| `pnpm --filter web build`（`tsc -b && vite build`） | 通过。产物在 `apps/web/dist`；主包体积超过 Vite 500 kB 提示。 |
| `pnpm --filter web lint` | 失败。2 个 error，0 个 warning。 |
| `pnpm --filter server exec tsc --noEmit --pretty false` | 失败。5 个 `TS5097`，全部在 `apps/server/src/scripts/prompt.check.ts`（`.ts` 后缀导入；当时 `tsconfig` 未开 `allowImportingTsExtensions`）。 |
| server lint | 审计当日没有脚本，也没有 ESLint 配置。 |
| server build | 没有脚本。开发入口是 `tsx watch src/index.ts`。 |
| `pnpm test` / 根或子包 `test` | 不存在。 |

Web lint 审计当日指出的两处（行号以当时文件为准，**未在本次修订中重跑 lint 复核**）：

1. `App.tsx`：`react-hooks/set-state-in-effect`，与身份加载里触发 `setCompanionName` 有关。
2. `RealtimeClient.ts`：`no-useless-assignment`，与 `played` 初始赋值有关。

### 手写检查脚本（审计当日）

审计当日这些脚本大多需用 `tsx` 直接跑。进程退出码如下（**未在本次文档修订中重跑**）。

| 脚本 | 退出码 | 说明 |
| --- | --- | --- |
| `apps/server/src/scripts/closeness.check.ts` | 0 | 远近分档断言通过。 |
| `apps/server/src/scripts/reunion.check.ts` | 0 | 重逢开场断言通过。 |
| `apps/server/src/scripts/aside.check.ts` | 0 | 留言与到期提醒文案断言通过。 |
| `apps/server/src/scripts/profile.check.ts` | 0 | 档案字段与整理管道用假的模型 JSON，不调用 Gemini。 |
| `apps/web/scripts/presence.check.ts` | 0 | 在场决策断言通过。 |
| `apps/server/src/scripts/meaning.check.ts` | 0 | 离线语义回退通过。live 段在供应商 503 后仍曾打出 `[meaning] live ok`。 |
| `apps/server/src/scripts/prompt.check.ts` | 1 | 本地提示词断言已执行到 live 段；live 因 Gemini 503 失败。 |
| `apps/server/src/scripts/persona.check.ts` | 1 | 本地人格断言已通过；live 段 503。 |
| `apps/server/src/scripts/between.check.ts` | 1 | 本地「我们之间」管道通过；live 整理 503。 |

说明：3 个非零退出发生在本地断言之后的 Gemini live 调用，原因是模型 503，不是本地断言内容不匹配。没有端到端浏览器测试；审计当日也没有打开页面做点击验证。
`tsx` 在部分沙箱环境会因 IPC 管道 `EPERM` 起不来；上表是审计当日在沙箱外重跑的结果。

## 问题清单（审计当日发现）

下列条目描述 **2026-10-15** 读到的源码问题。若某条已被后续提交修复，会在条末或「后续已提交修正」中标明；未标明的视为**对照 HEAD 时仍可能成立，但本次修订未逐项重跑验证**。

源码里当时没有 `TODO`、`FIXME`、`HACK` 或 `not implemented` 字样。空实现和未接线代码如下。

### 空实现与无响应接口

**审计当日：**`POST /api/memory/identity/name`（`index.ts`）在名字合法时不写库、不 `res.json`，请求会挂到客户端超时；非法名字才返回 400。同文件 `GET /api/memory/identity` 整段被注释。名字的产品入口是 `Companion.rename` 与 `POST /api/companion/rename`。

**后续：**该空壳路由已在 `0bdecb0` 删除。见「后续已提交修正」。

### 无调用代码

| 符号 | 位置 | 证据 |
| --- | --- | --- |
| `AffectStore.noteSeen` | `apps/server/src/affect/AffectStore.ts` | 全库只有定义。连上时间改由 `resume` 和 `follow` 写入。 |
| `MemoryStore.search` | `apps/server/src/memory/MemoryStore.ts` | 只有定义。检索走 `MemoryManager.recall`。 |
| `MemoryStore.findByKey` | 同上 | 只有定义。在用的是 `findCurrentByKey`。 |
| `MemoryStore.findByImportance` | 同上 | 只有定义。 |
| `MemoryStore.recall` | 同上 | 关键字打分实现。`MemoryManager.pick` 不调用它，改为 `selectByMeaning` 或 `literalMatches`。 |

`POST /api/memory` 与 `POST /api/memory/remember` 都能写入档案。前端工具只请求后者。前者在审计当日没有调用方（**是否仍无调用方：未在本次修订中全库重搜以外的方式验证；以源码检索为准时可再查**）。

### 重复实现

- 人格类型写了三份：`Persona.ts`、前端 `systemInstruction.ts` 同形类型、`RealtimeClient.parsePersona` 又声明一份。
- 记忆写入有两条 HTTP：`POST /api/memory` 与 `POST /api/memory/remember`。
- 星期表在 `openMemory.ts` 与 `sessionTime.ts` 各有一份。
- 天气、搜索、待办在 `RealtimeClient` 里写死 `http://localhost:3000`；记忆、情绪、身份、整理走相对 `/api`。

### 硬编码

- 端口 `3000`；默认代理 `http://127.0.0.1:1082`。
- 模型：Live `gemini-3.8-live`，情绪与整理 `gemini-3.8-flash`；部分脚本另有其它模型名。
- 语音名 `Leda`，输入 16 kHz PCM，输出 24 kHz。
- 默认名字 `阿七`（产品常量）。单用户行 id 多为 `"main"`。
- `apps/web/src/realtime/asides.ts` 把工具接话 PCM 以超长字面量嵌进源码，是前端主包体积的主要来源之一（审计当日观察；**未在本次修订中重新测量产物体积**）。
- 天气现象码表写在 `GET /api/weather` 处理函数内。

### 错误处理缺口

- ~~改名空接口不结束响应~~ → 已随空壳路由删除（`0bdecb0`）。
- Live 代理在上游还在 `CONNECTING` 且缓冲已达 32 条时，客户端消息被丢掉，没有回错。
- `POST /api/gemini/token` 失败时把上游 `error.message` 返回给浏览器。
- `GET /api/gemini/health` 返回出口 IP 和代理地址。
- `AffectStore.commit` 执行 `update` 后不看 `changes`。
- 部分检查脚本把本地断言和 live 调用放在同一进程；模型 503 会使退出码为 1（后续 live 与 offline 已拆分，见 `6da4466`）。
- 浏览器与服务端 `console.log` 可能打出转写、记忆内容、提醒句子等；没有分级与脱敏。

### 数据竞争与并发

- `setInterval` 里提醒扫描与留言决策交错；靠 `reminderSent` / `matterKey` 等减轻重复，仍可能对同一事各留一句。
- `POST /api/affect/appraise` 在 `await` 模型期间不锁行。
- `remember_memory` 与延迟 `consolidate` 都能写 `memories`，无跨请求锁。
- `voiceSessions` 只在本进程内存。
- 无 `WAL` pragma；部分写路径无事务包裹。
- 待办提醒领取本身是条件更新，双浏览器轮询不易双写成功。

前端身份加载的过期响应盖写风险，已在 `0bdecb0` 用纯函数门闩缓解（见功能矩阵测试说明）；**不是** React 集成测试已证明无竞态。

### 数据与迁移（审计当日）

- **审计当日：**`apps/server/companion.db` 曾被 git 跟踪（运行时用户数据，不是 schema）。
- **审计当日：**`0009` SQL 与 journal 已有，但缺 `meta/0009_snapshot.json`。
- 全库只有一个隐含用户；能访问 3000 端口即可读记忆、改名、拿 token。`cors()` 未收紧。

**后续部分已改，见下节。** 须区分：

1. **停止跟踪当前运行时数据库文件**（工作树不再把 `companion.db` 当已跟踪文件）——已做。
2. **从 Git 历史中清除数据库内容**（改写历史、从旧 commit 去掉曾提交过的库文件）——**尚未完成**，旧历史里仍可能含库文件。

### 产品与工程缺口（审计当日相对完整陪伴产品）

- 没有账号、设置页、导出或加密。
- 会话原文只留在浏览器 `localStorage`。
- 审计当日：没有服务端 lint、没有聚合 offline 测试入口、没有端到端测试。
- `index.html` 标题是 `web`，`lang="en"`，界面文案是中文。
- `apps/web/pnpm-lock.yaml` 与仓库根 lockfile 并存。

## 后续已提交修正（相对审计基线 → HEAD `3e9dd05`）

下列提交已在主线历史中；说明以 `git log` 为准。

| 提交 | 说明 |
| --- | --- |
| `8378b52` — `chore: stop tracking runtime database` | 停止跟踪运行时 `companion.db`（及同类临时文件），并由 `.gitignore` 忽略。**不是**从 Git 历史中清除曾提交过的数据库内容。 |
| `6da4466` — `test: isolate offline checks from production database` | 离线检查改为使用临时库，并增加路径隔离保护（`offlineGuard` / `offlineDb` / `offline.run` 等）；server 侧补齐 typecheck/lint 与 offline 聚合入口。不覆盖所有生产库误用场景。 |
| `0bdecb0` — `fix: make companion identity rename race-safe` | 删除空壳 `POST /api/memory/identity/name`；身份路由抽到 `identityRoutes.ts`；改名校验与错误码分层；前端身份加载门闩 + 纯函数竞态脚本；offline 增加 `rename.check.ts`。 |
| `3e9dd05` — `chore: add missing drizzle migration snapshot` | 补齐已存在的 `0009` 迁移所缺的 `meta/0009_snapshot.json`。未改 SQL、未执行迁移。 |

### 对照 HEAD 时仍宜视为未解决（除非另有提交）

- 无认证 / CSRF；`cors()` 默认放开。
- Git **历史**中可能仍含曾被跟踪的数据库文件（仅停止跟踪不足以清除历史）。
- 无端到端浏览器测试；身份竞态脚本不覆盖 React 集成。
- 日志可能打印转写与记忆内容；health/token 错误信息暴露问题。
- 双基址（`localhost:3000` vs 相对 `/api`）、无用户隔离等产品/工程缺口。

### 未提交工作区：阶段 1–6（相对 HEAD，2026-10-16 收尾）

阶段 1–6 稳定性改动仍在工作区、**尚未 commit**。第 6 阶段审查通过并允许收尾；不开始第 7 阶段。要点与限制见 `ARCHITECTURE.md`「未提交工作区：阶段 1–6」与 `FEATURE_MATRIX.md` 主动消息节。

**非阻塞 P2：**（1）完成待办刷新 `updatedAt` 可能使 speaking 租约 stale；（2）Aside deferred 后仍可能约每 5s 服务端 claim/settle 环（客户端已退避 `mentionDue`）。

**明确未验证：** 真实浏览器双标签、真实 Gemini Live、响应丢失端到端、播报中点完成、多进程并行 settle。

### 文档修订时引用过的后续核验（非本文件写作日重跑）

组 C（`0bdecb0`）提交前的对话核验曾报告下列命令退出码为 0（完整权限下）：`pnpm --filter server test:offline`、`pnpm check:server:type`、`pnpm check:server:lint`、`pnpm --filter web exec tsc -b --pretty false`、`pnpm --filter web lint`、`pnpm --filter web build`、`pnpm --filter web check:identity-race`。当时工作区根 `package.json` 里曾有过 `check:web:*` 别名指向上述 web 检查，但那些别名**并未提交到当前 HEAD**（HEAD 根脚本仅有 `dev:*`、`check:server:*`、`check:offline`）。工作区（未提交）已扩展根脚本与 `pnpm check` 聚合。
**若需证明当前工作区检查仍通过，以第 6 阶段收尾报告中的当次命令结果为准。**
