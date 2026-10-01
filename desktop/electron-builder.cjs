module.exports = {
  appId: 'app.xueness.desktop', productName: 'Xueness', asar: true,
  directories: { output: 'release', buildResources: 'build' },
  files: ['src/**/*', 'package.json'],
  extraResources: [
    { from: 'runtime/backend', to: 'backend' },
    { from: '../webapp/dist', to: 'webapp' },
    { from: '../LICENSE', to: 'LICENSE' },
    { from: '../NOTICE.md', to: 'NOTICE.md' },
  ],
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools',
    icon: '../webapp/public/icon_512@2x.png', identity: null,
    artifactName: 'Xueness-${version}-macos-${arch}.${ext}' },
  win: { target: ['nsis', 'zip'], icon: '../webapp/public/icon_512@2x.png',
    artifactName: 'Xueness-${version}-windows-${arch}-portable.${ext}' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true,
    perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false, artifactName: 'Xueness-${version}-windows-${arch}-setup.${ext}' },
};
