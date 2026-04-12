// Honcho integration placeholder
// Will be implemented when @honcho-ai/sdk is configured
// For now, memory relies on SQLite message history

export function isHonchoConfigured(): boolean {
  return !!(process.env.HONCHO_API_KEY && process.env.HONCHO_WORKSPACE_ID);
}

export async function initHoncho(): Promise<void> {
  if (!isHonchoConfigured()) {
    console.log('[honcho] not configured, using SQLite-only memory');
    return;
  }
  // TODO: Initialize Honcho client when SDK is available
  console.log('[honcho] initialized');
}
