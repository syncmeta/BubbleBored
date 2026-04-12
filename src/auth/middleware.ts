import { findUserById } from '../db/queries';
import { configManager } from '../config/loader';

export function checkAccess(userId: string, botId: string): { allowed: boolean; reason?: string } {
  const user = findUserById(userId);
  if (!user) return { allowed: false, reason: 'user not found' };
  if (user.status === 'blocked') return { allowed: false, reason: 'blocked' };

  try {
    const botConfig = configManager.getBotConfig(botId);

    if (botConfig.accessMode === 'private') {
      if (!botConfig.creators.includes(userId)) {
        return { allowed: false, reason: 'private bot' };
      }
    }

    if (botConfig.accessMode === 'approval' && user.status === 'pending') {
      return { allowed: false, reason: 'pending approval' };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'bot not found' };
  }
}
