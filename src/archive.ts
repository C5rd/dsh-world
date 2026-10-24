import { createHash } from 'node:crypto';
import { lastAssistantStreamChunk, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session';
import type { ArchiveScope, ConversationRecord } from './types.ts';

export function visibleText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'image' || block.type === 'file') return [JSON.stringify({ type: block.type, attachment: block.attachment })];
    return [];
  }).join('\n');
}

export function extractConversationRecords(event: SessionEvent, scope: ArchiveScope): ConversationRecord[] {
  const { header } = scope;
  if (header.agentPreset !== scope.agentPreset || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0 || event.seq < scope.inheritedEventCount) return [];
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return [];
  if (!isAppendSurfaceEvent(event)) return [];
  const message = event.type === 'user/message' ? event.data : event.data.message;
  if (event.type === 'user/message' && message.source.kind !== 'user') return [];
  const content = visibleText(message.content);
  if (!content) return [];
  const turn = event.type === 'assistant/message' ? event.data.turn : scope.turn;
  if (!Number.isSafeInteger(turn) || turn < 1) throw new Error(`dsh-world: no host turn for ${header.id}/${event.seq}`);
  return [{
    schemaVersion: 1, worldId: scope.worldId,
    recordId: createHash('sha256').update(JSON.stringify([scope.worldId, header.id, message.id])).digest('hex'),
    sourceSessionId: header.id, sourceMessageId: message.id, sourceSeq: event.seq,
    turnId: `${header.id}:${turn}`, role: event.type === 'user/message' ? 'user' : 'assistant',
    occurredAt: new Date(event.time).toISOString(), content,
    status: event.type === 'assistant/message' && (event.data.interrupted || lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind === 'max-tokens') ? 'interrupted' : 'complete',
  }];
}
