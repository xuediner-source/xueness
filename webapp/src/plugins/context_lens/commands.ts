export function openContextCommand(text: string, enabled: boolean, open: () => void): boolean {
  if (!enabled || text.trim() !== '/context') return false;
  open(); return true;
}
