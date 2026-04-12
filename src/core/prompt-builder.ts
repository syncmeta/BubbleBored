import { configManager } from '../config/loader';
import { getMessages } from '../db/queries';
import { annotateMessage } from './time';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export async function buildPrompt(params: {
  botId: string;
  conversationId: string;
  userMessage: string;
  extraContext?: string;
}): Promise<ChatCompletionMessageParam[]> {
  const botConfig = configManager.getBotConfig(params.botId);

  // Read prompts fresh (no cache)
  const systemPrompt = await configManager.readPrompt('system.md');
  let botPrompt = '';
  try {
    botPrompt = await configManager.readPrompt(`bots/${botConfig.promptFile}`);
  } catch {
    // Bot prompt file not found, use empty
  }

  // Build system message
  let system = systemPrompt;
  if (botPrompt) {
    system += '\n\n' + botPrompt;
  }
  if (params.extraContext) {
    system += '\n\n' + params.extraContext;
  }

  // Get history messages with time annotations
  const now = Math.floor(Date.now() / 1000);
  const history = getMessages(params.conversationId, 50);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];

  for (const msg of history) {
    const role = msg.sender_type === 'user' ? 'user' as const : 'assistant' as const;
    const annotated = annotateMessage(msg.content, msg.created_at, now);
    messages.push({ role, content: annotated });
  }

  // Add current user message
  messages.push({ role: 'user', content: params.userMessage });

  return messages;
}
