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
    // Only annotate user messages — annotating assistant messages causes the
    // model to mimic the pattern and emit time annotations in its own output.
    const content = role === 'user'
      ? annotateMessage(msg.content, msg.created_at, now)
      : msg.content;
    messages.push({ role, content });
  }

  // Add current user message
  messages.push({ role: 'user', content: params.userMessage });

  return messages;
}
