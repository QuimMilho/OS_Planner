import { contextBridge, ipcRenderer } from 'electron';

/**
 * What the web app can see of the desktop shell. It is optional: the website works fully without it
 * and only uses it to pick a better implementation (e.g. the native "Save as" dialog).
 */
const bridge = {
  isDesktop: true as const,
  version: process.env['npm_package_version'] ?? '',
  platform: process.platform,
  /** Opens the native "Save as" dialog and writes the file. Resolves false if the person cancelled. */
  saveFile: (data: ArrayBuffer, suggestedName: string): Promise<boolean> => ipcRenderer.invoke('save-file', data, suggestedName),
  /** Native menu items (New page, Search) are forwarded to the web app. */
  onMenuCommand: (callback: (command: string) => void): void => {
    ipcRenderer.on('menu-command', (_event, command: string) => callback(String(command)));
  },
};

contextBridge.exposeInMainWorld('notesDesktop', bridge);

// The bundled settings/offline pages (file://) may read and change the server address; web pages may not.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('notesConfig', {
    get: (): Promise<string> => ipcRenderer.invoke('config:get'),
    set: (value: string): Promise<{ ok: boolean; url?: string }> => ipcRenderer.invoke('config:set', value),
    validate: (value: string): Promise<boolean> => ipcRenderer.invoke('config:validate', value),
    openSettings: (): Promise<void> => ipcRenderer.invoke('config:open'),
  });
}
