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
    nodeExplicitUnusable: 'XUENESS_FRONT_DOOR_NODE 指向的程序无法运行：{0}\n请把它改成 Node.js {1} 或更新版本的 node 可执行文件，或删除这个环境变量以使用内置运行时。',
    nodeExplicitTooOld: 'XUENESS_FRONT_DOOR_NODE 指向的 Node 版本是 {0}，从源码运行需要 {1} 或更新版本。请更换路径，或删除这个环境变量以使用内置运行时。',
    nodeMissing: '从源码运行需要 Node.js {1} 或更新版本，但没有找到可用的 Node{0}。请安装 Node.js 24 LTS，或把 XUENESS_FRONT_DOOR_NODE 设为 node 可执行文件的路径。',
    backendLaunchFailed: '无法运行后端程序（{0}）。',
    backendStartupLog: '后端输出：',
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
    nodeExplicitUnusable: 'XUENESS_FRONT_DOOR_NODE points to a program that cannot run: {0}\nSet it to a Node.js {1}+ executable, or remove the variable to use the built-in runtime.',
    nodeExplicitTooOld: 'XUENESS_FRONT_DOOR_NODE points to Node {0}; running from source needs {1} or newer. Change the path, or remove the variable to use the built-in runtime.',
    nodeMissing: 'Running from source needs Node.js {1} or newer, but no usable Node was found{0}. Install Node.js 24 LTS, or set XUENESS_FRONT_DOOR_NODE to a node executable.',
    backendLaunchFailed: 'The backend program could not be run ({0}).',
    backendStartupLog: 'Backend output:',
  }),
});

function getNativeLabels(locale = 'zh') {
  return LABELS[locale] || LABELS.zh;
}

const fill = (template, ...values) => values.reduce((text, value, index) => text.replaceAll(`{${index}}`, String(value ?? '')), template);

/** The startup error dialog body: the general message plus what actually failed. */
function describeStartupFailure(error, labels) {
  if (error?.code === 'XUENESS_NODE_RUNTIME') {
    const { executable, version, minimum } = error.detail ?? {};
    if (error.reason === 'explicit-unusable') return fill(labels.nodeExplicitUnusable, executable, minimum);
    if (error.reason === 'explicit-too-old') return fill(labels.nodeExplicitTooOld, version, minimum);
    return fill(labels.nodeMissing, version ? ` (PATH: ${version})` : '', minimum);
  }
  const parts = [labels.startupErrorMessage];
  if (error?.spawnError) parts.push(fill(labels.backendLaunchFailed, error.spawnError));
  if (error?.startupLog) parts.push(`${labels.backendStartupLog}\n${error.startupLog.split(/\r?\n/).slice(-12).join('\n')}`);
  return parts.join('\n\n');
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
    // macOS keeps Close Window in File (Cmd+W); Quit remains in the app menu.
    // Windows keeps Quit in File (Alt+F), where its role also supplies the native shortcut.
    ...(mac ? [{ label: labels.file, submenu: [{ label: labels.closeWindow, role: 'close' }] }]
      : [{ label: labels.file, submenu: [{ label: labels.quit, role: 'quit' }] }]),
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
      { label: labels.minimize, role: 'minimize' },
      // role 'zoom' / 'front' 只在 macOS 生效；Windows 上是空操作，不展示。
      ...(mac ? [{ label: labels.zoom, role: 'zoom' }, { type: 'separator' }, { label: labels.bringToFront, role: 'front' }]
        : [{ type: 'separator' }, { label: labels.closeWindow, role: 'close' }]),
    ] },
  ];
}

module.exports = { getNativeLabels, buildApplicationMenu, describeStartupFailure };
