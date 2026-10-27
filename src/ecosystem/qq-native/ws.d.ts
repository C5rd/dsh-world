/**
 * `ws` 的最小类型声明。
 *
 * 这个仓库不把 `ws` 当直接依赖去解包（运行时它由宿主那边提供，`snowluma.ts` 也是通过
 * 被移植进来的客户端才用到它），所以这边只声明用得到的那几个形状，省掉一个 @types 包。
 */
declare module 'ws' {
  import type { IncomingMessage } from 'node:http';
  import type { EventEmitter } from 'node:events';

  export const OPEN: number;

  export class WebSocket extends EventEmitter {
    constructor(address: string, options?: Record<string, unknown>);
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    on(event: 'message', listener: (data: unknown) => void): this;
    on(event: 'close' | 'error', listener: (error?: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options: { host?: string; port: number; path?: string });
    on(event: 'connection', listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: 'listening', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
    once(event: 'listening', listener: () => void): this;
    once(event: 'error', listener: (error: Error) => void): this;
    close(callback?: () => void): void;
  }

  export default WebSocket;
}