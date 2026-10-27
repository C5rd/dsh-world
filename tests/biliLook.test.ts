/**
 * bili_look 的测试：走真实的限流、熔断、渲染，只把 fetch 换掉。
 *
 * 断言的都是「不许发生的事」：
 *   - 素材里不许出现推演出来的感想（工具只把东西取回来）
 *   - 被风控拦下之后不许继续打平台（冷却期内一次请求都不发）
 *   - 播放量、时长这类数字不许原样吐一串 1234567
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearCache, inCooldown, resetRisk, setFetch } from '../src/bili/client.ts';
import { biliLook } from '../src/bili/look.ts';

function stub(payload: unknown, calls: { count: number }): void {
  setFetch((async () => {
    calls.count += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
}

function fresh(): { count: number } {
  clearCache();
  resetRisk();
  const calls = { count: 0 };
  return calls;
}

test('热门列表带上 BV 号、时长和人能读的播放量，不写感想', async () => {
  const calls = fresh();
  stub({
    code: 0,
    data: {
      list: [{
        bvid: 'BV1xx411c7mD', aid: 17001, title: '生命起源：四十亿年前，地球如何诞生第一个生命？',
        owner: { name: '大圆镜科普' }, stat: { view: 1_442_000, danmaku: 1324 }, duration: 483, pubdate: 1_761_459_600, desc: '',
      }],
    },
  }, calls);
  const result = await biliLook({ what: 'hot' });
  setFetch(undefined);
  assert.equal(result.ok, true);
  assert.match(result.text, /BV1xx411c7mD/);
  assert.match(result.text, /8:03/);
  assert.match(result.text, /144\.2万/);
  assert.doesNotMatch(result.text, /我觉得|值得一看|很有意思/, '工具不替她下结论');
});

test('详情带上标签和简介，简介太长会截断', async () => {
  const calls = fresh();
  setFetch((async (url: string) => {
    calls.count += 1;
    const body = String(url).includes('/x/tag/archive/tags')
      ? { code: 0, data: [{ tag_name: '生物学' }, { tag_name: 'RNA世界假说' }] }
      : {
          code: 0,
          data: {
            bvid: 'BV1WYnd6DEAw', aid: 17002, title: '生命起源', owner: { name: '大圆镜科普' },
            stat: { view: 1_442_000, danmaku: 1324 }, duration: 483, pubdate: 1_761_459_600,
            desc: '生'.repeat(600), tname: '科学科普',
          },
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch);
  const result = await biliLook({ what: 'video', bvid: 'BV1WYnd6DEAw' });
  setFetch(undefined);
  assert.equal(result.ok, true);
  assert.match(result.text, /标签：生物学 \/ RNA世界假说/);
  assert.match(result.text, /科学科普/);
  assert.ok(result.text.length < 900, '简介截到 400 字，不把整篇塞回来');
});

test('被风控拦下之后进入冷却，冷却期内不再打平台', async () => {
  const calls = fresh();
  stub({ code: -412, message: '请求被拦截' }, calls);
  const first = await biliLook({ what: 'hot' });
  assert.equal(first.ok, false);
  assert.equal(inCooldown(), true, '-412 是风控码，要冷却');
  const before = calls.count;
  const second = await biliLook({ what: 'hot' });
  setFetch(undefined);
  assert.equal(second.ok, false);
  assert.equal(calls.count, before, '冷却期内一次请求都不发');
});

test('BV 号不对就不发请求', async () => {
  const calls = fresh();
  stub({ code: 0, data: {} }, calls);
  const result = await biliLook({ what: 'video', bvid: 'not-a-bvid' });
  setFetch(undefined);
  assert.equal(result.ok, false);
  assert.equal(calls.count, 0);
});
