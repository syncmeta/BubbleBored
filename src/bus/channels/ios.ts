import { BaseWebSocketChannel, type WsChannelData } from './base-ws';
import type { OutboundMessage } from '../types';

export type IOSWebSocketData = WsChannelData;

/**
 * iOS native client channel.
 *
 * Phase 1 (current): transport = WebSocket only. When the app is in the foreground
 * the iPhone holds a WS to /ws/mobile and messages flow just like the web channel.
 *
 * Phase 2 (with Apple Developer account): transport = WebSocket + APNs fallback.
 * `sendOffline` is the hook — when no WS is connected we will push the
 * OutboundMessage via APNs instead. See `src/push/apns.ts` (to be added)
 * and the `device_tokens` SQLite table.
 */
export class IOSChannel extends BaseWebSocketChannel<IOSWebSocketData> {
  readonly name = 'ios' as const;

  protected async sendOffline(_userId: string, _message: OutboundMessage): Promise<void> {
    // Phase 2 hook: no live WS → fall back to APNs. For now drop the message
    // (matches the web channel's behaviour when the user is offline).
    // TODO(apns): import pushApns from '../../push/apns' and call it here.
  }
}

export const iosChannel = new IOSChannel();
