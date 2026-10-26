import assert from 'node:assert/strict';
import test from 'node:test';
import { isCorruptSessionLog } from '../src/sourceArchive.ts';

test('读不动的会话日志只丢那一份，不拖垮整个插件', () => {
  // 这几种都是宿主的原文：坏在哪都无所谓，要紧的是认出它。
  assert.equal(isCorruptSessionLog(new Error('stored log is corrupt: unexpected end of file')), true);
  assert.equal(isCorruptSessionLog(Object.assign(new Error('boom'), { name: 'SessionFormatError' })), true);
  assert.equal(isCorruptSessionLog(new Error('system/message does not match an open turn and step')), true);
  // 别的错误照旧往外抛，不能被这道网兜住。
  assert.equal(isCorruptSessionLog(new Error('EACCES: permission denied')), false);
  assert.equal(isCorruptSessionLog(undefined), false);
});