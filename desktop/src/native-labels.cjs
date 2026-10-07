const LABELS = Object.freeze({
  zh: Object.freeze({
    about: '关于 Xueness', services: '服务', hideApp: '隐藏 Xueness', hideOthers: '隐藏其他', showAll: '显示全部',
    quit: '退出 Xueness', edit: '编辑', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴',
    selectAll: '全选', view: '视图', reload: '重新载入', resetZoom: '恢复默认缩放', zoomIn: '放大', zoomOut: '缩小',
    fullscreen: '切换全屏', window: '窗口', minimize: '最小化', zoom: '缩放', bringToFront: '全部置于最前面',
    closeWindow: '关闭窗口', file: '文件', startupErrorTitle: 'Xueness 启动失败',
    startupErrorMessage: '无法启动内置后端。请确认应用文件完整，并重新打开 Xueness。你的会话与模型配置保留在应用数据目录中。',
    reopenErrorMessage: '无法重新打开工作台。请重新启动 Xueness。你的会话与模型配置保留在应用数据目录中。',
    projectFolderTitle: '选择项目文件夹', backendStoppedTitle: 'Xueness 后端已停止',
    backendStoppedMessage: '请重新打开应用以恢复会话。已保存的数据不会删除。',
    updateNotReady: '更新服务尚未准备完成。', updatePermission: '无法确认桌面更新权限。',
    updateBusy: '请先结束当前任务，再重启更新。',
  }),
  en: Object.freeze({
    about: 'About Xueness', services: 'Services', hideApp: 'Hide Xueness', hideOthers: 'Hide Others', showAll: 'Show All',
    quit: 'Quit Xueness', edit: 'Edit', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste',
    selectAll: 'Select All', view: 'View', reload: 'Reload', resetZoom: 'Reset Zoom', zoomIn: 'Zoom In', zoomOut: 'Zoom Out',
    fullscreen: 'Toggle Full Screen', window: 'Window', minimize: 'Minimize', zoom: 'Zoom', bringToFront: 'Bring All to Front',
    closeWindow: 'Close Window', file: 'File', startupErrorTitle: 'Xueness failed to start',
    startupErrorMessage: 'The built-in backend could not start. Check that the application is complete, then reopen Xueness. Your sessions and model settings remain in the application data folder.',
    reopenErrorMessage: 'The workbench could not be reopened. Restart Xueness. Your sessions and model settings remain in the application data folder.',
    projectFolderTitle: 'Choose project folder', backendStoppedTitle: 'Xueness backend stopped',
    backendStoppedMessage: 'Reopen the app to restore your session. Saved data has not been deleted.',
    updateNotReady: 'The update service is not ready yet.', updatePermission: 'Could not verify desktop update permission.',
    updateBusy: 'Finish the current task before restarting to install the update.',
  }),
});

function getNativeLabels(locale = 'zh') {
  return LABELS[locale] || LABELS.zh;
}

function buildApplicationMenu(locale, platform) {
  const labels = getNativeLabels(locale);
  const mac = platform === 'darwin';
  return [
    ...(mac ? [{ label: 'Xueness', submenu: [
      { label: labels.about, role: 'about' },
      { type: 'separator' },
      { label: labels.services, role: 'services' },
      { type: 'separator' },
      { label: labels.hideApp, role: 'hide' },
      { label: labels.hideOthers, role: 'hideOthers' },
      { label: labels.showAll, role: 'unhide' },
      { type: 'separator' },
      { label: labels.quit, role: 'quit' },
    ] }] : []),
    { label: labels.edit, submenu: [
      { label: labels.undo, role: 'undo' }, { label: labels.redo, role: 'redo' }, { type: 'separator' },
      { label: labels.cut, role: 'cut' }, { label: labels.copy, role: 'copy' },
      { label: labels.paste, role: 'paste' }, { label: labels.selectAll, role: 'selectAll' },
    ] },
    { label: labels.view, submenu: [
      { label: labels.reload, role: 'reload' }, { label: labels.resetZoom, role: 'resetZoom' },
      { label: labels.zoomIn, role: 'zoomIn' }, { label: labels.zoomOut, role: 'zoomOut' },
      { label: labels.fullscreen, role: 'togglefullscreen' },
    ] },
    { label: labels.window, submenu: [
      { label: labels.minimize, role: 'minimize' }, { label: labels.zoom, role: 'zoom' }, { type: 'separator' },
      ...(mac ? [{ label: labels.bringToFront, role: 'front' }] : [{ label: labels.closeWindow, role: 'close' }]),
    ] },
    ...(!mac ? [{ label: labels.file, submenu: [{ label: labels.quit, role: 'quit' }] }] : []),
  ];
}

module.exports = { getNativeLabels, buildApplicationMenu };
