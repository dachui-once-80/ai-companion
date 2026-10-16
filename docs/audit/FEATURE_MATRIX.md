# 功能矩阵

初稿审计日期：2026-10-15。状态主要根据读到的调用链（推断接线是否存在），不根据文件名。
对照 HEAD `3e9dd05` 时，已订正过时的数据库跟踪与测试说明；**未把「源码里看得到」写成「已用测试证实」**，也未在本次修订中重跑 Gemini 在线或端到端验证。

状态用词：已接通 = 有写入、读取，并且产品路径会用到（接线推断）；部分 = 有实现，但范围比名称窄，或有一条断掉的路径；未做 = 没有可运行的产品行为。

## 总表

| 功能 | 状态 |
| --- | --- |
| 人格与系统提示词 | 已接通 |
| 多轮对话上下文 | 部分 |
| 会话历史持久化 | 部分 |
| 长期记忆提取 | 已接通 |
| 长期记忆保存 | 已接通 |
| 长期记忆检索 | 已接通 |
| 长期记忆更新 | 已接通 |
| 长期记忆删除 | 已接通 |
| 情绪状态 | 已接通 |
| 时间感 | 已接通 |
| 主动消息和定时任务 | 部分 |
| 语音输入和输出 | 已接通 |
| 用户设置 | 未做 |
| 数据安全 | 部分 |
| 日志 | 部分 |
| 单元测试 | 部分 |
| 集成测试 | 部分（离线临时库脚本；非全站 HTTP / 非 E2E） |
| 端到端测试 | 未做 |

## 人格与系统提示词

状态：已接通。

人格正文只定义在 `apps/server/src/companion/Persona.ts` 的 `PERSONA`。`freezeLines` / `freezeExamples` 在加载时拒绝空行，对象被 `Object.freeze`。注释写明不进数据库、没有修改接口。`persona.check.ts` 断言 `tastes` 不写库，且 `index.ts` 没有 `/api/companion/persona`。

名字在 `Companion.getIdentity` / `rename`（`apps/server/src/companion/Companion.ts`），落到 `CompanionProfileStore`（`apps/server/src/companion/CompanionProfileStore.ts`）。默认名 `阿七`（`Identity.ts` 的 `DEFAULT_COMPANION_NAME`）。HTTP 由 `apps/server/src/companion/identityRoutes.ts` 提供：`GET /api/companion/identity` 返回名字、曾用名和 `PERSONA`；`POST /api/companion/rename` 持久化改名（非法名 400，其它存储失败 500）。该路由抽离与校验分层见提交 `0bdecb0`。

提示词组装在浏览器：`apps/web/src/realtime/systemInstruction.ts` 的 `buildSystemInstruction`。`RealtimeClient.connect` 在 `ai.live.connect` 的 `systemInstruction.parts` 里调用它，参数包括身份、`memoryContext`、`betweenContext`、心情、看法、未决、问题、`describeSessionTime`、远近、留言。工具行为不在这篇提示里，而在 `sessionFunctionDeclarations` 各工具的 `description`。

证据（接线推断 + 审计当日脚本）：`prompt.check.ts` 对这篇提示做字符串断言，并确认提示里不出现工具名。2026-10-15 运行在进入 live 前曾打印新连线提示长度；live 随后因 Gemini 503 失败——这只说明当日 live 不可用，**不能**单独当作「提示已接线」的回归门禁。接线结论仍主要来自源码阅读。

缺口：前端自己再声明一份 `Persona` 类型。若服务端字段改了而 `parsePersona` 不认，连线会在取身份时失败，而不是静默丢掉人格。
身份显示：`App.tsx` 用 `identityLoad` 门闩降低「旧 identity 响应盖回旧名」的风险；配套脚本只测纯函数时序，见「测试」节。

## 多轮对话上下文

状态：部分。当前语音连线有多轮；新连线不重放原文。

当前连线的轮次由 Gemini Live 会话保持。客户端持续把麦克风送进 `session.sendRealtimeInput`，并处理转写与 `turn_complete`（`RealtimeClient`）。

连线中途还会往同一会话塞内部轮次，不当作新的用户消息展示：

- `cueReunion`：空档够三小时且用户还没说话时，把 `buildReunionOpening` 的 cue 发给模型并 `turnComplete: true`。
- `injectMood`：心情变化后 `turnComplete: false`，要求只改语气。
- `sendPresenceNote` / `nudgeReply`：在场状态，以及用户那句还没被接上时补一句。
- 相关记忆：`GET /api/memory/relevant` 与 `GET /api/memory/between`，由 `MemoryManager.relevantText` 和 `renderBetweenTopic` 生成。

`pendingDialogue` 是待整理缓冲，不是送回模型的历史。`dialogueWorthKeeping` 会丢掉过短的查找。

缺口：挂断后再呼叫，模型看不到上一场转写。能看到的是整理后的记忆、想法、情绪、上次见面时间和留言。同一场里若 Live 会话被服务端掐断，客户端没有把已说内容重新灌进新会话。

## 会话历史持久化

状态：部分。只在这一台浏览器留上一场。

`apps/web/src/talk/lastTalk.ts`：

- `createDraft` / `saveDraft`：本场写入 `localStorage` 键 `companion.talk`。
- `finishDraft`：挂断时收成 `LastTalk`。
- `settleStoredTalk`：页面重新打开时，没挂断的草稿收成上一场。
- 最多 400 行。只保留一场 `previous`，更早的被覆盖。
- `sentenceLooksFinished` 用句末标点判断「她没说完」。

`App.tsx` 的 `appendLine`、`endSession`、`startSession` 调用这些函数。见面页展示「上次停在」和「她没说完」，`#talk` 由 `TalkPage.tsx` 翻这一场。

服务端 schema 没有会话或消息表。`POST /api/memory/consolidate` 收到的是客户端挑过的批次，落成记忆和想法，不是逐句存档。

缺口：清站点数据、换浏览器、换设备，原文都没了。服务器日志里的 `console.log` 不是归档。

## 长期记忆

记忆存在 SQLite `memories`。类别在 `apps/server/src/memory/MemoryTypes.ts`：`identity`、`preference`、`fact`、`event`、`relationship`、`episode`、`impression`、`note`、`between`。档案 key 白名单在 `MemoryPolicy.ts` 的 `policies`。

### 提取

状态：已接通。

两条路：

1. 连线中模型调用 `remember_memory`。`RealtimeClient` 请求 `POST /api/memory/remember`，`MemoryManager.remember` → `MemoryStore.rememberMemory`。key 必须通过 `isValidMemoryKey`。单值 key 替换当前条，多值 key 追加。`profileFacts.ts` 会拒绝没说出口的难过方式，并把在意的日子收成固定日期格式。
2. 回合后延迟整理。`RealtimeClient.flushConsolidation` → `POST /api/memory/consolidate` → `consolidateConversation`（`apps/server/src/memory/consolidate.ts`）。服务端用 `gemini-3.8-flash` 和 `consolidationResponseSchema` 生成 JSON，再 `applyConsolidation` 写入片段、判断、笔记、档案、我们之间，以及 `ThoughtStore` 的看法 / 未决 / 问题。配额 429 时返回 `retryAfterMs` 且保存数为 0，不把错误当成功记忆。

`profile.check.ts` 用固定 JSON 走通整理（审计当日退出码 0，**本次文档修订未重跑**）。`between.check.ts` 的本地管道在审计当日通过；其对真实模型的一段当日 503。

### 保存

状态：已接通。

`MemoryStore.rememberMemory`、`saveCompanionMemory` 写 `memories`，并在替换类写入上使用 `db.transaction`。来源分为 `user` 与 `companion`。HTTP 记住接口强制 `source: "user"`。整理结果走 companion 路径。

`GET /api/memory` 的 `MemoryManager.getAll` 给记忆面板。`MemoryPanel` 在 `companion-memory-updated` 事件后重拉。该事件由 `RealtimeClient` 在记住成功后 `dispatchEvent`。

### 检索

状态：已接通。关键字版 `MemoryStore.search` / `MemoryStore.recall` 没有调用方。

在用的检索是 `MemoryManager.recall`：先 `collect`，再 `pick`。配置了 `MeaningDeps` 时走 `meaning.ts` 的 `selectByMeaning`（embedding 短名单，再让模型判断，分数低于 `MIN_SCORE` 就空）。没有 meaning 依赖时退回 `literalMatches`。

产品入口：

- 连线开始：`GET /api/memory/context` → `getContext` + `renderBetween`，进系统提示。
- 用户问旧事：工具 `recall_memory` → `GET /api/memory/search` → `memoryManager.recall`。
- 这句话像在提旧事：`GET /api/memory/relevant` → `relevantText`，最多 4 条，对不上就返回空字符串。

`index.ts` 把 `createGeminiMeaning` 传进 `MemoryManager`，所以线上检索会打 Gemini（接线推断）。`meaning.check.ts` 在审计当日 live 段曾退出码 0，并用脚本内**测试夹具**用语做命中区分；**不是**从用户数据库读出的真实记忆，也**未在本次文档修订中重跑** live。

### 更新

状态：已接通，策略不统一。

- 单值档案：再次 `remember` 替换当前内容，旧语义由 store 的单值策略处理。
- 多值档案里某一条不再成立：`forget_memory` → `POST /api/memory/forget` → `forgetCurrentMemory`。只把内容完全一致的当前行标成 `historical`。单值 key 调用 forget 会抛错，不能用这条接口改掉姓名或城市。
- 整理可以 `retireImpression`、`retireBetween`，以及关掉未决和问题。
- 记忆面板：`PATCH /api/memory/:id` 直接 `memoryStore.updateMemory`，可改 `content`、`importance`、`category`。这条不经过 `MemoryPolicy` 的基数检查。

### 删除

状态：已接通。

`MemoryPanel.deleteMemory` → `DELETE /api/memory/:id` → `MemoryManager.remove` → `MemoryStore.removeMemory` 物理删除。`memory:clear` 脚本调用 `MemoryStore.clear` 删光 `memories`，不删情绪、想法、待办。

缺口：面板类型里的类别没有 `between`，显示时用 `categoryLabels[category] ?? category`，所以「between」会以英文 key 出现，编辑和删除仍然可用。面板搜索是前端过滤已加载列表，不调用 `/api/memory/search`。

## 情绪状态

状态：已接通。

状态机在 `apps/server/src/affect/affect.ts`：四轴（valence、arousal、warmth、curiosity）、表情 `calm | happy | caring | curious | worried | annoyed | wronged`、半衰期衰减 `project`、重逢脉冲 `reunionImpulse`（空档 `REUNION_GAP_MS` = 3 小时）。持久化在 `AffectStore`（`apps/server/src/affect/AffectStore.ts`）表 `companion_affect`，行 id `main`。

更新入口：

- `POST /api/affect/resume`：连线时。隔了三小时会推一档重逢情绪，但返回的 `lastSeenAt` 仍是改库之前的时间，给时间感和重逢开场用。同时算 `resolveCloseness` 和 `buildReunionOpening`。
- `POST /api/affect/settle`：衰减到当前时刻。`App.tsx` 在未连接时每 20 秒调一次，把 `expression` 画到球体。
- `POST /api/affect/appraise`：`appraiseLocally`；`shouldConsultModel` 为真时再问 `gemini-3.8-flash`（`appraiseModel.ts` 的 `appraisalPrompt` / `parseModelAppraisal`）。模型失败则保留本地结果。然后 `AffectStore.follow`。

客户端 `parseCompanionAffect` 把表情收成 `CompanionEmotion`。`emotion_changed` 更新球体 class `orb-emotion-*`。系统提示里的「此刻的心情」来自 `describeMood`，并写明不要说出情绪名称。

`AffectStore.noteSeen` 没有调用方。情绪写入依赖 `resume` 和 `follow`。

并发：评定在 `await` 模型期间不锁行，后完成的请求覆盖先完成的。

## 时间感

状态：已接通。不是一个独立时钟服务，而是几处共用的时间规则。

| 行为 | 入口 | 证据 |
| --- | --- | --- |
| 现在几点、星期、凌晨到夜里的时段、很晚要说短 | `describeSessionTime` / `formatLocalClock` / `quietHours`，`apps/web/src/realtime/sessionTime.ts` | 连线时作为 `timeContext` 进入 `buildSystemInstruction` |
| 距上次连上多久 | 同文件 `formatGap` + `absenceLine`，上次时间来自 `AffectStore` 的 `lastSeenAt` | 提示里有「上次连上是 …」 |
| 隔了三小时才重逢开场 | `REUNION_GAP_MS`，`buildReunionOpening`（`apps/server/src/companion/reunion.ts`） | `reunion.check.ts` 审计当日通过（未在本次修订重跑）。不到三小时 `apart === false` 且 cue 为空 |
| 远近：刚认识 / 常聊 / 很熟 | `resolveCloseness`（`apps/server/src/companion/closeness.ts`），看第一次见面、温暖、留下的记忆数量 | `closeness.check.ts` 审计当日通过（未在本次修订重跑） |
| 情绪随钟点衰减 | `affect.ts` 的 `HALF_LIFE_MS` | `settle` 会按 `updatedAt` 衰减 |
| 在意的日子临近 | `profileFacts.parseImportantDate`，重逢和留言用 `DATE_NEAR_DAYS` | 日子写进 `important_date` 后，`listImportantDates` 能读出来。`profile.check.ts` 覆盖「每年 06-07」 |
| 待办到点 | `tasks.reminderAt` 与 15 秒扫描 | 见下一节 |

系统提示明确禁止把空档编成她度过的一段时间，也禁止主动报「分开了多久」。时间是约束说话，不是一份日程。

## 主动消息和定时任务

状态：部分。页面开着，或下次打开页面时，能收到；没有离开浏览器的推送。

待办 CRUD 在 `index.ts`：`GET/POST /api/tasks`，完成和删除。模型工具 `create_task`、`list_tasks`、`complete_task`、`delete_task` 由 `RealtimeClient` 调用这些接口。创建时可带 `dueAt`、`reminderAt`。没写提醒时间则不会进到期队列（`reminderScheduled` 只是响应字段）。

到期：`checkTaskReminders` 每 15 秒把到点项标成 `queued`。`GET /api/tasks/reminders` 用 `deliverReminder`（`apps/server/src/companion/aside.ts`）决定 `speak` 或 `leave`。`App.tsx` 的 `checkReminders` 每 5 秒拉取；语音开着则 `mentionDue`。结果经 `settle` 记为说过，或改成留言。

人不在语音里：`checkAside` 每 15 秒调用 `decideAside`。`aside.check.ts` 审计当日通过，覆盖「语音开着不留」「未听完的留言不覆盖」「三小时内不留」（**未在本次修订重跑**）。

Gemini `proactiveAudio: true` 允许模型在会话里主动出声。这依赖 Live 会话还连着。

缺口：没有 cron 守护进程，没有邮件、短信或 Web Push。浏览器通知不申请权限。服务端进程停了，15 秒扫描也停，到点项要等进程再起来才会入队。`voiceSessions` 不计浏览器标签，只计本进程上的 Live 代理连接。

## 语音输入和输出

状态：已接通。

`RealtimeClient.connect`：

- `responseModalities: [Modality.AUDIO]`
- `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName = "Leda"`
- `inputAudioTranscription` 与 `outputAudioTranscription`
- `startMicrophone`：`getUserMedia`，`ScriptProcessorNode`，`sendRealtimeInput` 的 `audio/pcm;rate=16000`
- 播放：输出 `AudioContext({ sampleRate: 24000 })`，`audio_playback_started` 把界面设为「正在说」
- 打断：`playback_interrupted` 把未说完的句子记进 `lastTalk`

传输：浏览器 → Vite 或同源 `/api/gemini/live-proxy` → `index.ts` 的 `WebSocketServer` → Gemini。代理未连通时最多缓冲 32 条，多了就丢。

工具接话：`asides.ts` 的 `asideLineFor` 在天气、搜索等慢工具前播放预录 PCM，避免干等。这和「她留下的」留言不是同一功能。留言是文本，在 `AsideStore`。

界面没有文字输入框。对话入口是「呼叫」按钮和麦克风。转写只用于展示和整理。

`ScriptProcessorNode` 已是废弃 API，当前代码仍用它采集。

## 用户设置

状态：未做。

没有设置路由或设置组件。`App.tsx` 的屏幕只有 `meet`、`memory`、`talk`（hash）。能改的持久项只有：

- 同伴名字：语音工具 `rename_companion` 或直接调 `POST /api/companion/rename`（经 `identityRoutes.ts`）。`sessionStorage` 键 `companion.currentName` 做显示缓存。
- 记忆面板里单条记忆的内容和重要程度。
- 浏览器若早已允许通知，提醒会弹系统通知。没有开关。

语音、模型、代理、城市默认值、人格都不能在界面里改。城市来自记忆 key `city`，给天气工具当居住地（`residenceCityForWeather`）。

## 数据安全

状态：部分。密钥在服务端，接口本身不设防。

做到的：

- `GEMINI_API_KEY` 与 `TAVILY_API_KEY` 只在 server 进程。浏览器拿的是 `uses: 1`、30 分钟过期的 ephemeral token（`POST /api/gemini/token`）。
- `.env` 在 gitignore 里。
- 记忆工具说明里写了不要记密码和令牌。这是提示约束，不是服务端过滤。`rememberMemory` 没有扫描密钥样式。
- 记忆面板删除前有 `window.confirm`。

没做到的 / 仅部分缓解的：

- 所有路由都没有登录、会话或 CSRF 校验。`cors()` 使用默认放开。
- 拿到 token 的页面可以经代理占用 Gemini 配额。token 接口失败时回传上游错误文本。
- `GET /api/gemini/health` 暴露出口 IP 和代理 URL。
- 运行时数据库：`8378b52` **已停止跟踪**工作区中的 `companion.db`，并由 `.gitignore` 忽略。这不等于从 Git **历史**中清除曾提交过的库文件；历史清理**尚未完成**。
- 单机单用户，行 id 固定 `"main"`。没有按用户隔离。
- 没有静态加密、备份接口或审计日志。
- 离线检查对临时库路径有隔离保护（`6da4466`），**不能**声称已覆盖全部生产库误用或误连场景。

## 日志

状态：部分。只有 `console.log` / `warn` / `error`。

服务端在 token 创建、天气和搜索失败、待办、整理条数、情绪表情、提醒句子、留言 key 上打日志。整理和记忆记住会打印内容。前端 `App` 对每条 `RealtimeMessage` 打 `[App message]`，里面包括转写。

没有日志库、级别开关、请求 id、文件滚动，也没有把密钥从错误对象里剥掉。token 失败路径会把 `Error.message` 写进 HTTP JSON。

## 测试

没有 Vitest/Jest/Playwright 等测试运行器。检查以手写 `*.check.ts` + `tsx` 为主。根目录仍无名为 `test` 的脚本；server 有 `test:offline`，web 有 `check:identity-race`（HEAD `3e9dd05` 可见）。

### 单元测试（纯函数 / 窄脚本）

状态：部分。

最接近单元测试的是不调用模型、或把模型替成假实现的断言脚本：

| 脚本 | 覆盖的函数 |
| --- | --- |
| `closeness.check.ts` | `resolveCloseness`、`renderCloseness` |
| `reunion.check.ts` | `buildReunionOpening` |
| `aside.check.ts` | `decideAside`、`deliverReminder`、`dueReminderLine` |
| `presence.check.ts` | `decidePresence` |
| `profile.check.ts` 前半 | `explicitWhenSad`、`normalizeImportantDate`、`parseImportantDate` |
| `persona.check.ts` 在 live 之前 | `PERSONA` 冻结、`holdSessionView`、`isPersonaRewrite` |
| `prompt.check.ts` 在 live 之前 | `buildSystemInstruction`、`sessionFunctionDeclarations` |
| `identity-race.check.ts` | `createIdentityGate` 的序号 / `invalidate` / `dropped` 时序 |

`apps/web/scripts/identity-race.check.ts`（`0bdecb0`）只验证**纯函数**门闩逻辑，用于降低「旧 identity 响应盖写新名」的风险。它**不是** React 组件测试，也**不是**浏览器端到端测试；`App.tsx` 接线是否在所有重渲染/Strict Mode 场景正确，**没有**自动化证明。

`MemoryStore`、`AffectStore`、完整 Express `index.ts` 没有独立单元测试。`profile.check.ts` 和 `between.check.ts` 用临时 SQLite 和假的 `generate`，介于单元和窄集成之间。

### 离线集成（临时库，非生产库）

状态：部分（`6da4466` 起）。

`pnpm --filter server test:offline`（`offline.run.ts`）在子进程里为各脚本准备临时 `COMPANION_DB`，并用 `offlineGuard` / `offlineDb` 拒绝指向真实开发库的路径（含部分符号链接 / hardlink 情形）。其中 `rename.check.ts`（`0bdecb0`）会对隔离库起本地 HTTP，断言改名校验与持久化。

这**不是**：

- 对正在运行的生产/开发 `index.ts` 长进程做的全套件；
- 对「所有可能误连生产库」场景的穷尽证明；
- Gemini 在线可用性门禁。

组 C 提交前核验曾报告 `test:offline` 与 `check:identity-race` 等退出码为 0；**撰写本矩阵修订时未重新执行**。

### 在线 / 供应商相关

状态：不稳定，不能当门禁。

`check:live:*` 与部分脚本的 live 段会打真实 Gemini。2026-10-15 审计时 meaning live 曾通过，between / prompt / persona live 曾 503。结果随供应商变化，**未在本次文档修订中重跑**。

### 端到端测试

状态：未做。

没有 Playwright、Cypress 或浏览器脚本。没有覆盖「呼叫 → 说话 → 记忆面板出现记录 → 挂断后上一场还在」的自动路径。审计当日与本次文档修订都没有打开 dev server 做这条人工点击。

## 和实现相邻、但不单列成功能的行为

这些有源码，上面的行已经用到，避免再标成独立产品功能：

- 在场：`apps/web/src/realtime/presence.ts` 的 `decidePresence`。旁边有人时少插嘴。已接进系统提示和 `commitPresence`。
- 对具体事的看法：`sessionView.ts` 的 `holdSessionView` 管本场；跨场的在 `ThoughtStore`。整理和 `hold_view` 工具会写。
- 远近：`closeness.ts`，在 `POST /api/affect/resume` 算完后放进系统提示。
- 我们之间：`between.ts` 与类别 `between`，由整理写入，由 `renderBetween` 读出。
