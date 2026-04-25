export function formatTimeAnnotation(messageTimestamp: number, now?: number): string {
  const current = now ?? Math.floor(Date.now() / 1000);
  const diff = current - messageTimestamp;

  if (diff < 0) return '';

  if (diff < 60) {
    return `${diff}秒前`;
  }

  if (diff < 3600) {
    return `${Math.floor(diff / 60)}分钟前`;
  }

  const msgDate = new Date(messageTimestamp * 1000);
  const nowDate = new Date(current * 1000);

  const pad = (n: number) => n.toString().padStart(2, '0');
  const hhmm = `${pad(msgDate.getHours())}:${pad(msgDate.getMinutes())}`;

  // Same calendar day
  if (
    msgDate.getFullYear() === nowDate.getFullYear() &&
    msgDate.getMonth() === nowDate.getMonth() &&
    msgDate.getDate() === nowDate.getDate()
  ) {
    return hhmm;
  }

  const mmdd = `${pad(msgDate.getMonth() + 1)}-${pad(msgDate.getDate())}`;

  // Same year
  if (msgDate.getFullYear() === nowDate.getFullYear()) {
    return `${mmdd} ${hhmm}`;
  }

  // Different year
  return `${msgDate.getFullYear()}-${mmdd} ${hhmm}`;
}

export function annotateMessage(content: string, timestamp: number, now?: number): string {
  const annotation = formatTimeAnnotation(timestamp, now);
  if (!annotation) return content;
  return `${content}\n<!-- ${annotation} -->`;
}
