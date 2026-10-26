export interface SpeakerIdentity {
  channel: string;
  accountId: string;
  conversationId: string;
  speakerId: string;
  speakerName?: string;
  conversationType?: 'private' | 'group';
  conversationName?: string;
  platformMessageId?: string;
  mentionIds?: string[];
}

/** Structured adapter metadata only; message text is never an identity source. */
export function speakerIdentity(value: unknown): SpeakerIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid identity');
  const input = value as Record<string, unknown>;
  for (const key of ['channel', 'accountId', 'conversationId', 'speakerId']) {
    const field = input[key];
    if (typeof field !== 'string' || !field.trim() || field.length > 256 || /[\u0000-\u001f\u007f]/.test(field)) throw new TypeError(`invalid ${key}`);
  }
  const channel = input.channel as string;
  const speakerId = input.speakerId as string;
  if (!/^[a-z][a-z0-9-]*$/.test(channel) || !speakerId.startsWith(`${channel}:`) || speakerId.length === channel.length + 1) throw new TypeError('invalid speakerId namespace');
  for (const key of ['speakerName', 'conversationName']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || /[\u0000-\u001f\u007f]/.test(input[key]))) throw new TypeError(`invalid ${key}`);
  if (input.conversationType !== undefined && input.conversationType !== 'private' && input.conversationType !== 'group') throw new TypeError('invalid conversationType');
  if (input.platformMessageId !== undefined && (typeof input.platformMessageId !== 'string' || !input.platformMessageId.trim() || input.platformMessageId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.platformMessageId))) throw new TypeError('invalid platformMessageId');
  if (input.mentionIds !== undefined && (!Array.isArray(input.mentionIds) || input.mentionIds.length > 64 || input.mentionIds.some(id => typeof id !== 'string' || !id.startsWith(`${channel}:`) || id.length <= channel.length + 1 || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)))) throw new TypeError('invalid mentionIds');
  return { channel, accountId: input.accountId as string, conversationId: input.conversationId as string, speakerId,
    ...(input.speakerName === undefined ? {} : { speakerName: input.speakerName as string }),
    ...(input.conversationType === undefined ? {} : { conversationType: input.conversationType as 'private' | 'group' }),
    ...(input.platformMessageId === undefined ? {} : { platformMessageId: input.platformMessageId as string }),
    ...(input.mentionIds === undefined ? {} : { mentionIds: [...input.mentionIds as string[]] }),
    ...(input.conversationName === undefined ? {} : { conversationName: input.conversationName as string }) };
}

export function conversationKey(identity: SpeakerIdentity): string {
  return JSON.stringify([identity.channel, identity.accountId, identity.conversationType ?? 'private', identity.conversationId]);
}

export function identityPrefix(identity: SpeakerIdentity): string {
  return `【消息来源 ${JSON.stringify(identity)}】\n`;
}
