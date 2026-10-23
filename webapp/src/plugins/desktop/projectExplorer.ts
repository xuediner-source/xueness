import { messages, t as tr } from '../../i18n';

messages['无法打开项目文件夹，请确认目录仍然存在且桌面端与文件插件已启用。'] = 'Unable to open the project folder. Check that it still exists and the desktop and files plugins are enabled.';

declare global {
  interface Window {
    xuenessDesktopProjects?: { openDirectory(root: string): Promise<{ ok: boolean; error?: string }> };
  }
}

export function hasProjectExplorer(): boolean {
  return typeof window !== 'undefined' && typeof window.xuenessDesktopProjects?.openDirectory === 'function';
}

export async function openProjectExplorer(root: string): Promise<void> {
  const result = await window.xuenessDesktopProjects?.openDirectory(root);
  if (!result?.ok) throw new Error(tr('无法打开项目文件夹，请确认目录仍然存在且桌面端与文件插件已启用。'));
}
