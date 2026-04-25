import {
  findUserByChannel, findConversationById, getAllMessagesAsc,
  updateMessageContent, deleteMessage, updateConversationRound,
  getAttachmentsForMessage,
} from '../db/queries';
import { unlinkAttachmentFiles } from './attachments';
import { handleUserMessage, signalNewMessage } from './orchestrator';
import { cancelPending as cancelPendingDebounce } from './debounce';
import { cancelPendingReview } from './review';
import type { OutboundMessage } from '../bus/types';

export interface RegenerateRequest {
  conversationId: string;
  channel: 'web' | 'ios';
  channelUserId: string;
  messageId?: string;
  newContent?: string;
  edits?: Array<{ messageId: string; content: string }>;
  replyFn: (msg: OutboundMessage) => void;
}

export interface RegenerateError {
  ok: false;
  status: number;
  error: string;
}

export interface RegenerateOk {
  ok: true;
  deletedCount: number;
  triggerMessageId: string;
  attachments: Array<{ id: string; mime: string; url: string }>;
}

export type RegenerateResponse = RegenerateError | RegenerateOk;

/**
 * Shared regenerate / edit implementation for web + iOS. Rewinds the
 * transcript to a chosen user message (optionally after applying edits),
 * kicks off a fresh generation, and returns a JSON-serializable result.
 */
export async function regenerateConversation(req: RegenerateRequest): Promise<RegenerateResponse> {
  const { conversationId: convId, channel, channelUserId, replyFn } = req;
  let { messageId, newContent } = req;
  const edits = req.edits;

  if (!channelUserId) return { ok: false, status: 400, error: 'userId required' };
  if (!messageId && (!edits || edits.length === 0)) {
    return { ok: false, status: 400, error: 'messageId or edits required' };
  }

  const conv = findConversationById(convId);
  if (!conv) return { ok: false, status: 404, error: 'conversation not found' };

  const user = findUserByChannel(channel, channelUserId);
  if (!user || user.id !== conv.user_id) {
    return { ok: false, status: 403, error: 'unauthorized' };
  }

  const all = getAllMessagesAsc(convId) as Array<{
    id: string; sender_type: string; sender_id: string; content: string;
  }>;
  const indexById = new Map(all.map((m, i) => [m.id, i]));

  // Multi-bubble edit path: apply each update, then anchor on the latest
  // edited user message. Edits must all reference user rows in this conv.
  if (edits && edits.length > 0) {
    let latestIdx = -1;
    let latestId: string | null = null;
    for (const e of edits) {
      if (!e?.messageId || typeof e.content !== 'string') {
        return { ok: false, status: 400, error: 'bad edit entry' };
      }
      const idx = indexById.get(e.messageId);
      if (idx === undefined) {
        return { ok: false, status: 400, error: `edit for unknown message ${e.messageId}` };
      }
      if (all[idx].sender_type !== 'user') {
        return { ok: false, status: 400, error: `cannot edit non-user message ${e.messageId}` };
      }
      updateMessageContent(e.messageId, e.content);
      all[idx].content = e.content;
      if (idx > latestIdx) {
        latestIdx = idx;
        latestId = e.messageId;
      }
    }
    if (latestId) {
      const existing = messageId ? indexById.get(messageId) ?? -1 : -1;
      if (existing < latestIdx) messageId = latestId;
    }
  }

  if (!messageId) return { ok: false, status: 400, error: 'messageId required' };
  const clickedIdx = indexById.get(messageId) ?? -1;
  if (clickedIdx < 0) return { ok: false, status: 404, error: 'message not found' };

  // Trigger = the user message the regeneration anchors on.
  // Clicked user message → itself; clicked bot → walk back to its user.
  let triggerIdx = -1;
  if (all[clickedIdx].sender_type === 'user') {
    triggerIdx = clickedIdx;
  } else {
    for (let i = clickedIdx - 1; i >= 0; i--) {
      if (all[i].sender_type === 'user') { triggerIdx = i; break; }
    }
  }
  if (triggerIdx < 0) {
    return { ok: false, status: 400, error: 'no user message to regenerate from' };
  }
  const trigger = all[triggerIdx];

  // Single-message edit path (legacy / 重来 button). Skipped when `edits` handled above.
  let effectiveContent = trigger.content;
  if (!edits && typeof newContent === 'string' && newContent !== trigger.content) {
    updateMessageContent(trigger.id, newContent);
    effectiveContent = newContent;
  }

  // Drop everything after the trigger — the user is rewinding to that point.
  const toDelete = all.slice(triggerIdx + 1);
  const paths: string[] = [];
  for (const m of toDelete) {
    paths.push(...deleteMessage(m.id));
  }
  unlinkAttachmentFiles(paths).catch(() => {});

  updateConversationRound(convId, conv.round_count, 'user');

  // Cancel anything mid-flight on this conversation. Without cancelPendingDebounce
  // a queued flush would fire handleUserMessage AFTER the regen starts and
  // double-process against the rewound transcript.
  signalNewMessage(convId);
  cancelPendingDebounce(convId);
  cancelPendingReview(convId);

  handleUserMessage({
    conversationId: convId,
    botId: conv.bot_id,
    userId: trigger.sender_id,
    userMessages: [{ content: effectiveContent }],
    replyFn,
    regenerate: true,
  }).catch(e => {
    console.error('[regen] error:', e);
    replyFn({ type: 'error', conversationId: convId, content: '重新生成失败，稍后再试' });
  });

  const triggerAtts = getAttachmentsForMessage(trigger.id).map(a => ({
    id: a.id, mime: a.mime, url: `/uploads/${a.id}`,
  }));
  return {
    ok: true,
    deletedCount: toDelete.length,
    triggerMessageId: trigger.id,
    attachments: triggerAtts,
  };
}
