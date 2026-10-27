/**
 * frames 的测试：只测不碰网络、不碰 ffmpeg 的那一半。
 *
 * 断言的都是「不许发生的事」：
 *   - 取帧位置不许落在片头黑场和片尾下滑栏里
 *   - 帧数不许无限多（一次几百帧等于把整条视频下下来）
 *   - 不是 BV 号就当场退回，不许去探测 ffmpeg、也不许发请求
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameTimes, grabFrames } from '../src/bili/frames.ts';
import { biliLook } from '../src/bili/look.ts';

test('九帧均布，掐掉头尾各 4%', () => {
  const times = frameTimes(483, 9);
  assert.equal(times.length, 9);
  assert.ok(Math.abs(times[0]! - 483 * 0.04) < 0.01);
  assert.ok(Math.abs(times[8]! - 483 * 0.96) < 0.01);
  for (let i = 1; i < times.length; i++) assert.ok(times[i]! > times[i - 1]!);
});

test('时长未知时退回每 5 秒一帧，不从负数开始', () => {
  assert.deepEqual(frameTimes(0, 3), [0, 5, 10]);
});

test('帧数有上限，免得把整条视频拉下来', () => {
  assert.equal(frameTimes(600, 500).length, 16);
  assert.equal(frameTimes(600, 0).length, 9);
});

test('不是 BV 号就当场退回，不去探测 ffmpeg', async () => {
  const result = await grabFrames({ bvid: 'not-a-bv', dir: process.cwd() });
  assert.equal(result.ok, false);
  assert.equal(result.why, '不是 BV 号');
  assert.equal(result.shots, 0);
});

test('没配拼图目录时，frames 说明白缺什么，而不是抛错', async () => {
  const result = await biliLook({ what: 'frames', bvid: 'BV1WYnd6DEAw' });
  assert.equal(result.ok, false);
  assert.match(result.note, /拼图目录/);
});
