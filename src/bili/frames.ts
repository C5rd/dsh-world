/**
 * frames.ts —— 让她真的看见画面，而不是只读别人替她写的字
 *
 * 只做一件事：从视频里取几帧，拼成一张图，存成她磁盘上的一个文件。
 * 之后她用 read_image 读它——原生多模态是通的，不需要别的入口。
 *
 * 为什么不下载整段：B 站给了 dash 直链，ffmpeg 能直接从 http 拉流并 seek。
 * 抽 9 帧只要几次短 seek，合计几秒、几 MB，而不是把几十 MB 全下下来。
 *
 * 为什么均布而不按镜头切换：跨整条视频找镜头切换要读完整个流（网络代价 = 全量下载）。
 * 均布是覆盖优先的折中——看得见「这条大致是什么样」，而不是「某一分钟切了几个镜头」。
 *
 * 不带 cookie：匿名就能拿到直链，只是清晰度受平台档位限制。要「听见话」（字幕轨）
 * 才需要登录，那是另一件事，不在这里做。
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { playurl, video } from './client.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 一帧用掉多少秒的网络等待上限 */
const FRAME_TIMEOUT_MS = 25_000;

/** 同一目录最多留几张拼图；超出的按修改时间删最旧的。 */
const KEEP_SHEETS = 20;

export interface GrabResult {
  ok: boolean;
  /** 拼图文件的绝对路径，正斜杠；失败时为空串。 */
  path: string;
  why: string;
  title: string;
  duration: number;
  shots: number;
}

export interface GrabOptions {
  bvid: string;
  /** 拼图存哪儿；不存在会建。 */
  dir: string;
  /** 取几帧，默认 9（3×3）。 */
  frames?: number;
  /** 显式指定 ffmpeg 路径，不传就按 PATH 找。 */
  ffmpeg?: string;
}

function run(bin: string, args: string[], timeoutMs = FRAME_TIMEOUT_MS): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    let stderr = '';
    let done = false;
    const child = spawn(bin, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code: -1, stderr: `${stderr}\n(timeout)` });
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += String(chunk); });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -2, stderr: error instanceof Error ? error.message : String(error) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -3, stderr });
    });
  });
}

/** 探测本机有没有可用的 ffmpeg。只读，不装任何东西。 */
export async function detectFfmpeg(bin = 'ffmpeg'): Promise<{ ok: boolean; bin: string; why: string }> {
  const result = await run(bin, ['-version'], 8000);
  if (result.code === 0) return { ok: true, bin, why: '' };
  return { ok: false, bin, why: result.code === -2 ? `没找到 ${bin}` : `${bin} 跑不起来：${result.stderr.slice(0, 200)}` };
}

/**
 * 取哪几个时间点：掐掉头尾各 4%（片头黑场和片尾下滑栏最没信息量），中间均布。
 * 时长未知时退回每 5 秒一帧。
 */
export function frameTimes(duration: number, count: number): number[] {
  const n = Math.max(1, Math.min(16, Math.floor(count) || 9));
  const times: number[] = [];
  if (duration > 0) {
    const low = duration * 0.04;
    const high = duration * 0.96;
    for (let i = 0; i < n; i++) times.push(low + (high - low) * i / Math.max(1, n - 1));
  } else {
    for (let i = 0; i < n; i++) times.push(i * 5);
  }
  return times;
}

/** 目录里只留最近 KEEP_SHEETS 张拼图，超出的按 mtime 删最旧的。失败不影响这次的结果。 */
async function pruneSheets(dir: string): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    const sheets = names.filter(name => name.startsWith('sheet-') && name.endsWith('.png'));
    if (sheets.length <= KEEP_SHEETS) return;
    const stats = await Promise.all(sheets.map(async name => {
      const full = join(dir, name);
      const stat = await fs.stat(full).catch(() => undefined);
      return { full, at: stat?.mtimeMs ?? 0 };
    }));
    stats.sort((a, b) => a.at - b.at);
    for (const old of stats.slice(0, stats.length - KEEP_SHEETS)) await fs.rm(old.full, { force: true });
  } catch {
    /* 清理是顺手的事，不值得为它报错 */
  }
}

export async function grabFrames(options: GrabOptions): Promise<GrabResult> {
  const fail = (why: string): GrabResult => ({ ok: false, path: '', why, title: '', duration: 0, shots: 0 });
  const bvid = String(options.bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid)) return fail('不是 BV 号');

  const ff = await detectFfmpeg(options.ffmpeg ?? 'ffmpeg');
  if (!ff.ok) return fail(`本机没有可用的 ffmpeg（${ff.why}）。装好再试，或先只看文字。`);

  const info = await video(bvid);
  if (!info.ok || !info.video) return fail(info.message ?? '取不到这条视频的信息');
  const cid = info.cid;
  const link = await playurl(bvid, cid);
  if (!link.ok || !link.url) return fail(link.message ?? '拿不到播放直链（可能要登录，或这条不允许外链拉流）');

  const duration = Number(info.video.duration) || 0;
  const headers = [
    `Referer: https://www.bilibili.com/video/${bvid}`,
    `User-Agent: ${UA}`,
    'Accept: */*',
    '',
  ].join('\r\n');

  const dir = options.dir;
  const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
  const temp = join(dir, `tmp-${stamp}`);
  try {
    await fs.mkdir(temp, { recursive: true });
    const times = frameTimes(duration, options.frames ?? 9);
    let shots = 0;
    for (let i = 0; i < times.length; i++) {
      const out = join(temp, `f${String(i + 1).padStart(2, '0')}.png`);
      // 一次失败多半是那一下网络抖了、或正好 seek 到关键帧边界；往后挪一点再试一次。
      for (const attempt of [0, 1]) {
        const at = attempt === 0 ? times[i]! : Math.min(times[i]! + 1.5, duration > 0 ? duration - 1 : times[i]! + 1.5);
        const result = await run(ff.bin, [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-headers', headers,
          '-ss', at.toFixed(2),
          '-i', link.url,
          '-frames:v', '1',
          '-vf', 'scale=360:-2',
          out,
        ]);
        const stat = await fs.stat(out).catch(() => undefined);
        if (result.code === 0 && stat && stat.size > 512) { shots++; break; }
        await fs.rm(out, { force: true }).catch(() => undefined);
      }
    }

    if (shots === 0) return fail('一帧都没取到（可能被风控，或这条不允许外链拉流）');

    const columns = times.length <= 4 ? 2 : 3;
    const rows = Math.ceil(times.length / columns);
    const sheet = join(dir, `sheet-${bvid}-${stamp}.png`);
    const tile = await run(ff.bin, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-framerate', '1',
      '-i', join(temp, 'f%02d.png'),
      '-vf', `scale=360:-2,tile=${columns}x${rows}:padding=4:margin=4:color=white`,
      '-frames:v', '1',
      sheet,
    ], 60_000);
    const stat = await fs.stat(sheet).catch(() => undefined);
    if (tile.code !== 0 || !stat || stat.size < 1024) return fail(`拼图失败：${tile.stderr.slice(0, 200) || '未知原因'}`);

    // 交给模型的路径用正斜杠：反斜杠写进 markdown 图片会显示成「无法预览」
    return { ok: true, path: sheet.replace(/\\/g, '/'), why: '', title: info.video.title, duration, shots };
  } finally {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    await pruneSheets(dir);
  }
}
