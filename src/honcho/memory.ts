// Honcho memory helpers - placeholder
// Currently memory is served from SQLite message history
// These will wrap Honcho SDK calls when integrated

export async function getUserProfile(_userId: string): Promise<{
  card: string[];
  representation: string;
}> {
  // Placeholder - return empty profile
  return { card: [], representation: '' };
}

export async function writeConclusion(
  _botId: string,
  _content: string,
  _sessionId: string,
): Promise<void> {
  // Placeholder - conclusions stored in SQLite messages for now
}
