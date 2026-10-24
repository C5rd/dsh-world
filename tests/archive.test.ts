import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeMessage, MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import { extractConversationRecords } from '../src/archive.ts';

const header: SessionHeader = { id: SessionId('a'), version: 4, createdAt: 0, isSeeded: false, agentPreset: 'companion' };
const scope = { worldId: 'fish', agentPreset: 'companion', header, inheritedEventCount: 0, turn: 1 };
const user = (id: string, text: string): SessionEvent<'user/message'> => ({ type: 'user/message', seq: SessionSeq(2), time: 1792758600000, surfaceOp: 'append', data: freezeMessage({ role: 'user', id: MessageId(id), source: { kind: 'user' }, content: [{ type: 'text', text }] }) });
const assistant = (id: string): SessionEvent<'assistant/message'> => ({ type: 'assistant/message', seq: SessionSeq(3), time: 1792758601000, surfaceOp: 'append', data: { turn: 1, step: 1, message: freezeMessage({ role: 'assistant', id: MessageId(id), source: { kind: 'model', provider: 'test', model: 'test' }, content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'visible' }, { type: 'tool-call', id: 'call' as never, name: 'tool', arguments: '{}' }] }), stream: [] } });

test('consecutive users and proactive assistant share host turn identity', () => {
  const records = [user('u1', 'one'), user('u2', 'two'), assistant('m1')].flatMap(e => extractConversationRecords(e, scope));
  assert.deepEqual(records.map(r => [r.turnId, r.role, r.content]), [['a:1', 'user', 'one'], ['a:1', 'user', 'two'], ['a:1', 'assistant', 'visible']]);
  assert.equal(extractConversationRecords(assistant('proactive'), scope).length, 1);
});
test('replay is stable, regenerated message is independent, inherited messages are excluded', () => {
  const first = extractConversationRecords(assistant('m1'), scope)[0];
  assert.deepEqual(extractConversationRecords(assistant('m1'), scope), [first]);
  assert.notEqual(extractConversationRecords(assistant('m2'), scope)[0].recordId, first.recordId);
  assert.deepEqual(extractConversationRecords(assistant('m1'), { ...scope, inheritedEventCount: 4 }), []);
});
test('injected, replaced, delegated and other-preset messages are not experiences', () => {
  const injected = user('u', 'injected');
  for (const kind of ['runtime-context', 'time-context', 'dsh-world-history', 'subagent']) {
    assert.deepEqual(extractConversationRecords({ ...injected, data: { ...injected.data, source: { kind } } } as never, scope), []);
  }
  assert.deepEqual(extractConversationRecords({ ...injected, surfaceOp: { op: 'replace', startSeq: SessionSeq(0), endSeq: SessionSeq(0) } }, scope), []);
  assert.deepEqual(extractConversationRecords(injected, { ...scope, header: { ...header, origin: 'subagent' } }), []);
  assert.deepEqual(extractConversationRecords(injected, { ...scope, agentPreset: 'other' }), []);
  for (const type of ['tool/result', 'assistant/attempt', 'turn/start', 'system/message']) assert.deepEqual(extractConversationRecords({ type } as never, scope), []);
});
test('interrupted visible text is marked, thinking-only settlement is excluded', () => {
  const event = assistant('m');
  const interrupted: SessionEvent<'assistant/message'> = { ...event, data: { ...event.data, interrupted: true } };
  assert.equal(extractConversationRecords(interrupted, scope)[0].status, 'interrupted');
  const hidden: SessionEvent<'assistant/message'> = { ...event, data: { ...event.data, message: { ...event.data.message, content: [{ type: 'reasoning', text: 'secret' }] } } };
  assert.deepEqual(extractConversationRecords(hidden, scope), []);
});
test('output-limit truncation is archived as interrupted visible text', () => {
  const event = assistant('limited');
  event.data.stream = [{ type: 'chunk', time: event.time, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }];
  assert.equal(extractConversationRecords(event, scope)[0].status, 'interrupted');
});
