/**
 * Preload bridge — the only surface the two windows get.
 * No Node access from webContent; only whitelisted IPC channels.
 */
import { contextBridge, ipcRenderer } from "electron";

const invokeChannels = [
  "agent:identity",
  "agent:copy",
  "agent:quit",
  "agent:status",
  "session:stop",
  "screen:info",
  "screen:cursor",
  "screen:cursorRaw",
  "screen:bounds",
  "platform:info",
  "input:inject",
  "stats:report",
  "rtt:report",
  "capture:primary-source",
  "capture:dimensions",
  "turn:config",
  "win:minimize",
  "win:close",
] as const;

const onChannels = [
  "status:update",
  "clipboard-changed",
  "session:ended-by-user",
  "session:stop",
] as const;

contextBridge.exposeInMainWorld("remotex", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!(invokeChannels as readonly string[]).includes(channel)) {
      return Promise.reject(new Error(`channel not allowed: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!(onChannels as readonly string[]).includes(channel)) {
      return () => {};
    }
    const wrapper = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  },
});
