declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-world-history': { kind: 'dsh-world-history'; form: 'recall' };
    'dsh-world-summary-input': { kind: 'dsh-world-summary-input' };
    'dsh-world-life': { kind: 'dsh-world-life' };
    'dsh-world-channel-context': { kind: 'dsh-world-channel-context'; form: 'recall' };
    /** 她自己想说话时那条：「没人跟你说话，你要不要说点什么」——不是谁发来的。 */
    'dsh-world-proactive': { kind: 'dsh-world-proactive'; form: 'nudge' };
  }
}
export {};
