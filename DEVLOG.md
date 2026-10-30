# 开发日志

`CHANGELOG.md` 面向使用者，记每个版本里发生了什么。这里面向维护者，记**为什么这么改**：
撞到什么问题、读过哪些源码、放弃了哪条路、怎么确认改对了、还剩什么没做。

上游那份不带这个文件。这条分支（`lianor`）从 `3306c6b` 起，从那里往后每一次改动都记在这里。

## 怎么写

- 一条一次改动。标题一句话说清改了什么，日期在左，**新条目加在当天最前面**。
- 必写三项：**撞到什么**（现象，带文件与行号）、**为什么这样改**（没选的那条也写）、**怎么确认**（命令与结果）。
- 走过弯路就照实写，判错几次写几次。抹掉的记录比没有更糟。
- 不写"感觉良好"，写"284 个测试全过""`node --check` 通过"。

---

## 2026-10-30

### 合入上游 0.6.5 与 0.6.6：四个冲突、一个交付复审挑出的 P2、一个和代码无关的 tar

**撞到什么。** 我这条分支起于 `3306c6b`（0.5.6），停在 `d543063`（0.6.1）。这期间上游 `main` 走了两版：0.6.5（`79ab378`）与 0.6.6（`1c4ea61`）。拖下去只会更难合，所以今天合。

见鹿先用 ChatGPT 做了一份预合并交付（`0.6.5-lianor.1`）。我逐项复审过：双父提交 `d4cdb01` 的两个 parent 分别是我的 `d543063` 和上游的 `79ab378`，我的六个提交都在，`frames` / `bili_look` / 分账 / `inWorldDir` 四处功能都在，`spent()` 那个冲突解对了（我的 `spend.sessions` 累加和上游的提醒逻辑都留着）。

**为什么没直接把交付装上去。** 交付合的是 0.6.5，而上游已经出到 0.6.6。装上去等于刚合完就落后一版，还得再合一次。所以只把交付当"第一步合好的一段历史"接过来（`git merge --ff-only delivery/lianor-0.6.5`），在它上面再合 `upstream/main`。

**四个冲突怎么解的。** `CHANGELOG.md`、`README.md`、`package.json`、`package-lock.json`，四个都是"两边都改了同一个位置"。一律留两边的：版本号取 `0.6.6-lianor.1`（我的分支自己的版本号，同时注明上游基线 0.6.6）；README 保留上游新的微信/QQ/注意事项三段，再改版本句；CHANGELOG 顶部新开本节所属的 `## 0.6.6-lianor.1`，其下原样保留上游的 `## 0.6.6`。

**交付复审挑出的 P2 是真的，我改了。** 原来那段退款自愈硬编码 `session-b14f73f8…`，每次启动都查一遍。问题是：那扇窗以后真在这个世界目录里花了钱，重启时会被当成脏数据再退一次。现在 `Spend` 加 `reclaimed?: string[]`，退过的 id 记进去，`!reclaimed.includes(straySession)` 才算数；另加一条测试 `the reclaim is not repeated`，喂一份带 `reclaimed` 的 `life.json`，断言钱和份额都留着。

**这里我犯了一个错，写下来。** 解 `package-lock.json` 冲突时我直接取了上游那份，结果它里面**没有** `@deepseek-ai/*` 这些 peer 的条目（我 0.6.1 的 lock 里有）。于是 `npm ci` 一路报 `Missing: @deepseek-ai/cordis from lock file`，typecheck 报 95 个 `Cannot find module`——全是缺 peer 的级联错，不是代码坏。绕了一圈才认出来：**冲突时取哪一边，要先看那一边有没有丢掉东西，不能只看它新。**

**怎么确认。** 手工把 peer 装进 `node_modules`（`--save-dev` 装完再把 `package.json`/`package-lock.json` 还原，不把临时的东西带进提交）之后：

- `npm run typecheck` → **0 个错**（这才是代码的真实状态）。
- `npm test` → **464 个测试，463 过，1 挂**。挂的是 `tests/plugin.test.ts:836` 的 `WebSocket was closed before the connection was established`——QQ 在连接建立前被 stop 的时序问题，连跑两次中过一次，是 flaky。
- 另有 9 个一开始也挂，查明与代码无关：`tests/updateWorld.test.mjs` 调 `tar -czf C:\...`，而 Git Bash 的 GNU tar 1.35 把 `C:` 当远端主机名（`tar (child): Cannot connect to C: resolve failed`）。把 `tar` 换成 Windows 自带的 bsdtar 之后 **13/13 全过**。

**还欠一件事。** `npm ci` 在干净 checkout 上仍然装不起来（上游 0.6.6 的 `package-lock.json` 不含 peer 条目，且 `dsh-session` 的范围 `>=0.2.1-rc.2 <0.3.0-0` 与 `dsh-session-projection@0.2.1-rc.2` 的精确 peer 要求冲突）。这是上游的问题，不是这次合并带进来的——预合并交付包在干净 clone 上同样装不起来。要不要在分支里修，等真需要 CI 的时候再定。

---

## 2026-10-29

### 账算到了不该算的窗口上：计价加一句工作目录判断

**撞到什么。** 按窗口分账上线后，控制台第一次列出三个会话，其中一个 5.63 元的从来没见过。查下去：`session-b14f73f8…` 活在 `D:\DSH\PP\P0`，10-19 就开了，今天 10:33 还在写——它不属于这个世界，只是用了同一个 agent preset。根因在 `src/sourceArchive.ts:19` 的 `belongsToWorld`：判断只有 `header.agentPreset === config.agentPreset && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0`，**没有一条问它工作目录在哪**。后果不只是数字难看：今天真实总数 7.36 元里 5.63 是它的，`dailyBudget` 6 元那道闸被它顶响了一次（`spend.reminded: true`），而这个世界这一天其实只花了 1.36。

**为什么这样改。** 在计价那一行加 `inWorldDir(session.header?.cwd, worldRoot)`：cwd 等于世界目录或在它之下才算。三条取舍写在这里：

- **没有去改 `belongsToWorld`。** 它同时管着归档、记忆注入和工具挂载，改它一处会连带三处行为。计价是唯一需要「这个世界花了多少」这个语义的地方，就只改这一处。
- **没记 cwd 的会话放行。** `meta.cwd` 是可选字段，`typeof cwd !== 'string'` 时返回 `true`：不知道它在哪，不等于它在外面；宁可多算，不悄悄丢钱。
- **遇到过一次遮蔽。** `start(options: { resumed?: boolean })` 里的 `options` 覆盖了外层的 `options`，直接写 `options.worldDir` 会被 `tsc` 抓住（`TS2339: Property 'worldDir' does not exist`）。所以在外层读一次 `const worldRoot = options.worldDir;`，并在注释里写明为什么。

**怎么确认。** `npm run typecheck` 干净；`npm test` 293 → 295，两条新的——`a window opened outside the world directory keeps its own money`（cwd 为 `D:/somewhere/else` 的会话跑一轮，断言总数一个分毫没动、`sessions` 里只有一个窗口）、`the money a window in another folder spent is taken back off the account on start`（`life.json` 里放一条 5.63 的外来账，启动后 `yuan` 从 7.74 回到 2.11、那条不见了、`reminded` 被撤）。安装版 `lib/life/runtime.js` 18812 → 19590 → 20334 字节，`node --check` 通过；回退点 `_backup/before-patch5/`（两版都在）。

**改过一次主意。** 先写在这里的是「`life.json` 里那条 5.63 不删——账本改了就不叫账本」。见鹿立刻指出：总数他在平台 API 上看得到，这个世界只需要自己的数；留着它，预算那道闸会被别人的活顶响。这话对，而且更根本：那一笔本来就不是「这个世界花掉的」，它是记账错误，不是真实开销。所以退了——启动时认那个会话 id，从 `yuan` 里减去、从 `sessions` 里删掉、把误响的 `reminded` 撤掉，然后照常写盘。一次性，幂等，认 id 不认时间。

## 2026-10-27

### 版本号：0.5.6 → 0.6.0

**撞到什么。** fork 之后加了三个功能（花费分账、`bili_look`、`frames`），`package.json` 还停在上游的 0.5.6。按 semver，加功能该升次版本号；但 fork 一旦升版本，就会和上游将来可能出现的同名版本撞上。

**为什么这样定。** 从此独立演进：本分支的 `0.6.0` 与上游的 `0.6.0`（如果会有）没有对应关系；每次同步上游时在条目里注明对应的上游版本。另一个理由更小但更实——README 那句「只校了一处：版本号」在正文改过之后本身就不准了，所以一并改成「改写了两处」。记录写错了要改，不能让它自己成为下一个不实之处。

**怎么确认。** `package.json`、`package-lock.json`（顶层与 `packages[""]` 两处）、README 正文、CHANGELOG 顶部五处版本号一致；`npm test` 293 全过。

### 花费：只算家里这一扇窗

**撞到什么。** 世界控制台显示「今日花费 ¥0.92」，但同一世界的另一个会话已经跑了一整天。

`src/life/runtime.ts:279` 的顺序是这样的：

```ts
if (!belongsToWorld(session, config)) return;
journal.world(session, event);
if (session.id !== state.homeSessionId) return;   // ← 不是家，走人
journal.home(session, event);
if (event.type === 'assistant/message' && event.data.usage) spent(...);  // ← 只有家到得了
```

`belongsToWorld`（`src/sourceArchive.ts:19`）用的是 `header.agentPreset === config.agentPreset && header.origin !== 'subagent' && (header.delegationDepth ?? 0) === 0`——同 preset 的第二个会话属于这个世界，`journal.world` 记了它，下一行就被挡回去。

**为什么。** 不止是数字偏低：`dailyBudget` 那道每天上限的闸也只拦家会话，另一扇窗跑多少都不涨、超支不提醒。改法是把计价提到判断之前，让「一个世界一个账」写在代码里而不是写在注释里。

**怎么确认。** 新增一条测试：起家跑一轮，再 `createAgent(s.ctx, 'side-0')` 跑一轮，断言差值为一个 `step`。`npm test` 283 → 284 全过。

### 花费：控制台按窗口分别记账

**撞到什么。** 计价修好之后只有一个总数，看不出哪扇窗花了多少。

**为什么。** `Spend` 加 `sessions?: Record<string, number>`，按 session id 累加（`src/life/types.ts:9`）；`src/console/snapshot.ts` 加 `spendShares()`，家的排最前、其余按金额降序；前端 `Budget` 用现成的 `KV(rows)` 列出「家 / 会话前 8 位 / 此前没拆开」。加 `此前没拆开` 是因为旧数据没有分项——不假装拆得开。

**怎么确认。** `tests/console.test.ts:190` 的 budget 形状断言改成 `{ daily: 3, today: null, sessions: [] }`；跨窗那条补了三句（分项数 = 2、合计 = 总额、侧窗 = 一个 `step`）。`npm test` 284 全过，`node --check` 过。

### B 站：一个只读的看世界的入口

**撞到什么。** 输入全部来自同一个人，没有「我想看看别的」的接口。

**为什么。** 只读、不带 cookie、不点赞不评论；限流（`MIN_GAP_MS = 800` + 抖动）与熔断（`-352`/`-412`/`-509` 命中即冷却 30 分钟）；素材里不写感想。「不回显状态」也是设计的一部分——不告诉使用者今天还剩几次，她要判断的是内容，不是额度。

**没做什么。** 搜索：`/x/web-interface/search` 要 wbi 签名（nav 取 `img_key`/`sub_key` 再 mixin），不做就先把 `keyword` 参数删掉，不留空壳。

**怎么确认。** `tests/biliLook.test.ts` 四条断言的都是一次失败：渲染里不许出现「我觉得 / 值得一看 / 很有意思」；`-412` 之后冷却期内 `calls.count` 不许再增；BV 号不对时一次请求都不发。`npm test` 284 → 288。

### B 站：frames 模式，把画面变成磁盘上的文件

**撞到什么。** 详情、标签、热评都是**别人替这段视频写的字**，到不了「视频里到底是什么样」。

**为什么**（这条是照着一个同类插件的做法读出来的）：`playurl(bvid, cid)` 拿 dash 直链，ffmpeg 带 `Referer` 从 http 流 `-ss` seek 取单帧，9 帧均布（掐头尾各 4%），`tile=3x3` 拼一张 PNG。宿主会话本身就有读图能力，所以只要把画面落成文件、把路径交回去，原生多模态就通了——不需要拼 image content block。

均布而不按镜头切换：跨整条视频找镜头切换要读完整个流，网络代价等于全量下载。均布是覆盖优先的折中。

**不下载整段**，也**不带 cookie**——匿名 playurl 就返回 `code 0`、`quality: 64`、4 条 `dash.video` 轨。

**怎么确认。** `tests/biliFrames.test.ts` 五条：九帧均布且掐头尾 4%；时长未知退回每 5 秒一帧；帧数上限 16（免得变成全量下载）；不是 BV 号当场退回、不探测 ffmpeg；没配目录时 `note` 说得清缺什么。`npm test` 288 → 293。

实跑：483 秒的视频取 9 帧、拼图 1.6 MB、不到 20 秒。

**边界写在这里**：帧上带硬字幕，所以能读到九个句子；**旁白听不见**。要「听见话」得走字幕轨（`/x/player/wbi/v2`，要 wbi 签名 + 登录 cookie）或本地 ASR，两条都没做。

**踩到的坑。** `cp -r _build/bili "$W/lib/bili"` 在目标目录已存在时会嵌套成 `lib/bili/bili/`，`ls` 才看得出来。改成 `cp _build/bili/*.js`。

### 校字：README 两处

- 标题下加一段说明这是 fork、`main` 是稳定版、`lianor` 从 `3306c6b` 起、上游 PR 提 `dev`、这里不自动往回提。
- 「当前版本 0.5.3」改成 `0.5.6`——`package.json` 和 `CHANGELOG.md` 都是 0.5.6，只有 README 没跟上；`#053--2026-10-26` 的锚点一起改成 `#056`。

这两处是 `lianor` 与上游第一次不同。
