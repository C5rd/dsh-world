// 容器里的冒烟：起宿主 → 假 OneBot 喂一条假群消息 → 断言端点收到了 → 再开一次阳台 → 收工。
//
// 断言的是「装得上、起得来、收得到、开得出来」，不是「她回话」（那要模型凭据）。
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = process.env.SMOKE_PORT || '3355';
const ONEBOT_PORT = 39003;
const GROUP = '681528777';
const USER = '3475994805';
let BASE = `http://127.0.0.1:${PORT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
function check(ok, what, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failed += 1;
}
async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
async function postJson(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-world': '1' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

// ── 假 OneBot：一个 WebSocket 服务端，收指令、推事件 ──────────────────────────
function startFakeOneBot() {
  const server = new WebSocketServer({ port: ONEBOT_PORT });
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', raw => {
      // 对面会发 {action, params, echo}；冒烟里只认 get_login_info，其余一律 ok
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!frame?.action) return;
      const data = frame.action === 'get_login_info' ? { user_id: 2039693365, nickname: '大肥鱼' } : { message_id: 1 };
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo ?? null }));
    });
  });
  /** 推一条群消息进去 */
  const pushGroup = (text, messageId) => {
    const event = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      self_id: 2039693365,
      user_id: Number(USER),
      group_id: Number(GROUP),
      message_id: messageId,
      time: Math.floor(Date.now() / 1000),
      raw_message: text,
      message: [{ type: 'text', data: { text } }],
      sender: { user_id: Number(USER), nickname: 'S.TOP', card: '' },
    };
    for (const socket of sockets) socket.send(JSON.stringify(event));
    return sockets.size;
  };
  return { server, pushGroup, connections: () => sockets.size };
}

async function main() {
  console.log(`① 起宿主：dsh web --patch docker/container.yml --port ${PORT}`);
  const host = spawn('dsh', ['web', '--patch', '/plugin/docker/container.yml', '--port', PORT, '--no-open'], { env: { ...process.env, DSH_HOME: process.env.DSH_HOME || '/dsh-home' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const hostLog = [];
  const keep = chunk => {
    const text = String(chunk).trimEnd();
    hostLog.push(text);
    if (hostLog.length > 40) hostLog.shift();
    for (const line of text.split('\n')) if (line.trim()) console.log(`   [宿主] ${line}`);
  };
  host.stdout.on('data', keep);
  host.stderr.on('data', keep);
  host.on('exit', code => {
    if (code !== 0 && code !== null) console.log(`   [宿主] 退出了，退出码 ${code}`);
  });

  // 等它就绪。端口未必是我们要的那个（web 应用不一定认 --port），所以也从它自己的输出里捡。
  let snapshot = null;
  const tried = new Set([Number(PORT)]);
  for (let i = 0; i < 90 && !snapshot; i += 1) {
    await sleep(1000);
    for (const line of hostLog) {
      for (const hit of line.matchAll(/http:\/\/[^\s:]+:(\d+)/g)) tried.add(Number(hit[1]));
    }
    for (const port of tried) {
      const base = `http://127.0.0.1:${port}`;
      try {
        const res = await fetch(`${base}/dsh-world/console/snapshot`);
        if (res.status === 200) {
          const body = await res.json();
          if (body && typeof body === 'object') {
            snapshot = body;
            BASE = base;
            console.log(`   [冒烟] 宿主在 ${base} 上应答了`);
            break;
          }
        }
      } catch {
        /* 还没起来 */
      }
    }
  }
  check(snapshot !== null, `宿主应答了 /dsh-world/console/snapshot`, BASE);
  if (!snapshot) {
    // 到这儿最常见的原因不是宿主没起来，而是插件**装上了却没活**。把它的原话打出来。
    const failedImport = hostLog.join('\n').match(/dsh-world \(dsh-world\): failed to import: ([^\n]+)/);
    const notActivated = /(\d+) entr(y|ies) did not activate/.exec(hostLog.join('\n'));
    if (failedImport) {
      console.log(`   ↗ 插件装上了，但载入时就失败了：${failedImport[1].slice(0, 160)}`);
      if (failedImport[1].includes('@snowluma/sdk')) {
        console.log('     （这就是它在 Linux 上的现状：那个包在大小写敏感的文件系统上解析不了自己的 dist，见 docker/README.md）');
      }
    } else if (notActivated) {
      console.log(`   ↗ 宿主说有 ${notActivated[1]} 个条目没被激活，但没给原因。`);
    }
    console.log('\n宿主的最后几行输出：');
    for (const line of hostLog.slice(-15)) console.log(`   ${line}`);
    host.kill('SIGKILL');
    process.exit(1);
  }
  check(Boolean(snapshot.native), '快照里有 native（原生通道那块活着）');

  // ② 假 OneBot + 一条假群消息
  console.log('② 假 OneBot 喂一条群消息（不 @ 她，按 mention 规则只该进上下文）');
  const fake = startFakeOneBot();
  await sleep(1500);
  const native0 = (await getJson('/dsh-world/qq/native')).body || {};
  check(native0.connected === true, '原生通道连上了假 OneBot', `url=${native0.url ?? '?'}`);
  check(native0.groupTrigger === 'mention', '群规则是 mention', String(native0.groupTrigger ?? '?'));

  const before = native0.lastEventAt ?? null;
  const conns = fake.pushGroup('容器冒烟：这句话应该被接住', 700001);
  check(conns > 0, '假 OneBot 上有一个连接', `连接数 ${conns}`);

  let native1 = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    native1 = (await getJson('/dsh-world/qq/native')).body || {};
    if (native1.lastEventAt && native1.lastEventAt !== before) break;
  }
  check(
    Boolean(native1?.lastEventAt) && native1.lastEventAt !== before,
    '事件到了插件（lastEventAt 跳了）',
    `${before ?? 'null'} → ${native1?.lastEventAt ?? 'null'}`,
  );
  check((native1?.conversations ?? 0) >= 1, '进上下文了（conversations ≥ 1）', String(native1?.conversations ?? 0));

  // ③ 阳台：从面板接口开一下，再连上去打个招呼
  console.log('③ 阳台：POST 开 3210，再连上去');
  const on = await postJson('/dsh-world/qq/native', { bridge: { port: 3210 } });
  const bridge = on.body?.bridge ?? null;
  check(on.status === 200 && bridge?.serving === true, '阳台开在 3210', `status=${on.status}`);
  const token = bridge?.token ?? '';
  check(Boolean(token), '阳台给了口令', token ? `${token.slice(0, 8)}…` : '空的');

  if (bridge?.serving) {
    const greeted = await new Promise(resolve => {
      const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
      const timer = setTimeout(() => {
        socket.terminate();
        resolve(false);
      }, 8000);
      socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', token })));
      socket.on('message', raw => {
        try {
          if (JSON.parse(String(raw))?.kind === 'ready') {
            clearTimeout(timer);
            socket.close();
            resolve(true);
          }
        } catch {
          /* 忽略 */
        }
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    check(greeted, '阳台认了这条线（收到 ready）');
    await postJson('/dsh-world/qq/native', { bridge: { port: 0 } });
  }

  // ④ 收工
  host.kill('SIGKILL');
  fake.server.close();
  await sleep(500);
  console.log(`\n${failed === 0 ? '冒烟通过 ✓' : `有 ${failed} 项没过 ✗`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error('冒烟脚本自己炸了：', error);
  process.exit(1);
});