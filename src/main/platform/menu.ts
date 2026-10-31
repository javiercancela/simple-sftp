import { Menu, type MenuItemConstructorOptions } from 'electron';

/**
 * Release menu: nothing that reloads the page or opens developer tools.
 * macOS keeps the standard app/Edit/Window menus (copy and paste in text
 * fields depend on the Edit menu there); Windows and Linux get no menu bar.
 * Ctrl/Cmd+R is handled by the renderer as "refresh folder".
 */
export function installAppMenu(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      role: 'editMenu',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      role: 'windowMenu',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
