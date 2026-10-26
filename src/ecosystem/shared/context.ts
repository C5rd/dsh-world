import { conversationKey, speakerIdentity, type SpeakerIdentity } from './identity.ts';

export interface ChannelImage { file: string; quality: 'original' | 'cached' | 'thumbnail' }
export interface ChannelContextMessage { id: string; occurredAt: string; text: string; identity: SpeakerIdentity; image?: ChannelImage }

export function channelContext(value: unknown, current: SpeakerIdentity): ChannelContextMessage[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [];
  if (current.conversationType !== 'group' || !Array.isArray(value) || value.length > 8 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024) throw new Error('Invalid group context');
  let images = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || item.id.length > 256 || /[\u0000-\u001f\u007f]/.test(item.id)
      || typeof item.occurredAt !== 'string' || item.occurredAt.length > 40 || !Number.isFinite(Date.parse(item.occurredAt))
      || typeof item.text !== 'string' || !item.text.trim() || [...item.text].length > 2000) throw new Error('Invalid context message');
    const identity = speakerIdentity(item.identity);
    if (conversationKey(identity) !== conversationKey(current)) throw new Error('Context belongs to another conversation');
    let image: ChannelImage | undefined;
    if (item.image !== undefined) {
      if (!item.image || typeof item.image !== 'object' || typeof item.image.file !== 'string' || !/^[a-f0-9]{64}\.png$/.test(item.image.file)
        || !['original', 'cached', 'thumbnail'].includes(item.image.quality) || ++images > 2) throw new Error('Invalid group image');
      image = { file: item.image.file, quality: item.image.quality };
    }
    return { id: item.id, occurredAt: item.occurredAt, text: item.text, identity, ...(image ? { image } : {}) };
  });
}
