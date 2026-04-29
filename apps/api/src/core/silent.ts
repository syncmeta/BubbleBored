export function checkSilent(text: string): { isSilent: boolean; cleanedText: string } {
  const trimmed = text.trim();
  if (trimmed === '[SILENT]' || trimmed.startsWith('[SILENT]')) {
    return { isSilent: true, cleanedText: trimmed.replace('[SILENT]', '').trim() };
  }
  return { isSilent: false, cleanedText: trimmed };
}
