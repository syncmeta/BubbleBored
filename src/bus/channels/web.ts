import { BaseWebSocketChannel, type WsChannelData } from './base-ws';

export type WebSocketData = WsChannelData;

export class WebChannel extends BaseWebSocketChannel<WebSocketData> {
  readonly name = 'web' as const;
}

export const webChannel = new WebChannel();
