import { contextBridge, ipcRenderer } from 'electron';

/**
 * What the web app can see of the desktop shell. It is optional: the website works fully without it
 * and only uses it to pick a better implementation (e.g. the native "Save as" dialog).
 */
// A packaged app has no npm_package_version: the main process knows the real one (and whether this start follows an update).
const info = ipcRenderer.sendSync('desktop:info') as { version: string; updatedFrom: string | null };

const bridge = {
  isDesktop: true as const,
  version: info.version,
  /** The version this install was updated from, set only on the first page load after an update. */
  updatedFrom: info.updatedFrom,
  platform: process.platform,
  /** The page tells the shell when a restart would cost something (a call, an open dialog, unsaved work), so a silent update waits. */
  setBusy: (busy: boolean): void => ipcRenderer.send('app:busy', !!busy),
  /** Opens the native "Save as" dialog and writes the file. Resolves false if the person cancelled. */
  saveFile: (data: ArrayBuffer, suggestedName: string): Promise<boolean> => ipcRenderer.invoke('save-file', data, suggestedName),
  /** Native menu items (New page, Search) are forwarded to the web app. */
  onMenuCommand: (callback: (command: string) => void): void => {
    ipcRenderer.on('menu-command', (_event, command: string) => callback(String(command)));
  },
};

contextBridge.exposeInMainWorld('osPlannerDesktop', bridge);

// The bundled settings/offline pages (file://) may read and change the server address; web pages may not.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('osPlannerConfig', {
    get: (): Promise<string> => ipcRenderer.invoke('config:get'),
    set: (value: string): Promise<{ ok: boolean; url?: string }> => ipcRenderer.invoke('config:set', value),
    validate: (value: string): Promise<boolean> => ipcRenderer.invoke('config:validate', value),
    openSettings: (): Promise<void> => ipcRenderer.invoke('config:open'),
  });
}
