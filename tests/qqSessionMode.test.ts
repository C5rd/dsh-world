import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBridgeSessionMode } from '../src/qq/bridge.ts';

function makeBridge(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-world-qq-mode-'));
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return dir;
}
function readConfig(dir: string): any {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
}

test('会话绑定：空值就一个字都不动桥的配置', () => {
  const dir = makeBridge({ dsh: { baseUrl: 'http://127.0.0.1:6934' }, socialV2: { enabled: true } });
  try {
    const before = readFileSync(join(dir, 'config.json'), 'utf8');
    const result = syncBridgeSessionMode(dir, '');
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'no-mode');
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话绑定：owner 写进去，别的键一个都不丢', () => {
  const dir = makeBridge({ dsh: { baseUrl: 'http://127.0.0.1:6934' }, allow: { groups: ['456'] } });
  try {
    const result = syncBridgeSessionMode(dir, 'owner');
    assert.equal(result.changed, true);
    assert.equal(result.mode, 'owner');
    assert.equal(result.before, '');
    const config = readConfig(dir);
    assert.equal(config.socialV2.bindHomeSession, 'owner');
    assert.equal(config.dsh.baseUrl, 'http://127.0.0.1:6934');
    assert.deepEqual(config.allow.groups, ['456']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话绑定：同一个值不重复写盘', () => {
  const dir = makeBridge({ socialV2: { bindHomeSession: 'owner' } });
  try {
    const stamp = readFileSync(join(dir, 'config.json'));
    const result = syncBridgeSessionMode(dir, 'owner');
    assert.equal(result.changed, false);
    assert.equal(result.before, 'owner');
    assert.deepEqual(readFileSync(join(dir, 'config.json')), stamp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话绑定：owner 改 all 会覆盖，并交出旧值', () => {
  const dir = makeBridge({ socialV2: { bindHomeSession: 'owner', enabled: true } });
  try {
    const result = syncBridgeSessionMode(dir, 'all');
    assert.equal(result.changed, true);
    assert.equal(result.before, 'owner');
    const config = readConfig(dir);
    assert.equal(config.socialV2.bindHomeSession, 'all');
    assert.equal(config.socialV2.enabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话绑定：none 是把键删掉，不是写成空串', () => {
  const dir = makeBridge({ socialV2: { bindHomeSession: 'owner', enabled: true } });
  try {
    const result = syncBridgeSessionMode(dir, 'none');
    assert.equal(result.changed, true);
    assert.equal(result.before, 'owner');
    const config = readConfig(dir);
    assert.equal('bindHomeSession' in config.socialV2, false);
    assert.equal(config.socialV2.enabled, true);
    assert.equal(syncBridgeSessionMode(dir, 'none').changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('会话绑定：没有 config.json 时讲清原因，不抛', () => {
  const dir = makeBridge(undefined);
  try {
    const result = syncBridgeSessionMode(dir, 'owner');
    assert.equal(result.changed, false);
    assert.match(String(result.reason), /config\.json 读不到/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});