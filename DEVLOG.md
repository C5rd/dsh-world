# 开发日志

`CHANGELOG.md` 面向使用者，记每个版本里发生了什么。这里面向维护者，记**为什么这么改**：
撞到什么问题、读过哪些源码、放弃了哪条路、怎么确认改对了、还剩什么没做。

上游那份不带这个文件。这条分支（`lianor`）从 `3306c6b` 起，从那里往后每一次改动都记在这里。

## 怎么写

- 一条一次改动。标题一句话说清改了什么，日期在左。
- 必写三项：**撞到什么**（现象，带文件与行号）、**为什么这样改**（没选的那条也写）、**怎么确认**（命令与结果）。
- 走过弯路就照实写，判错几次写几次。抹掉的记录比没有更糟。
- 不写"感觉良好"，写"284 个测试全过""`node --check` 通过"。

---

## 2026-10-27

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
