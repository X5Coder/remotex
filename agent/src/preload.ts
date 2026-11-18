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
  "agent:new-password",
  "agent:notify",
  "session:stop",
  "screen:info",
  "screen:cursorRaw",
  "screen:bounds",
  "platform:info",
  "input:inject",
  "capture:primary-source",
  "turn:config",
  "turn:status",
  "turn:setup",
  "turn:web-link",
  "turn:auto-setup",
  "turn:auto-cancel",
  "shell:open-external",
  "win:minimize",
  "win:close",
] as const;

const onChannels = [
  "status:update",
  "session:tick",
  "session:renewed",
  "clipboard-changed",
  "session:ended-by-user",
  "session:stop",
  "session:new-password",
  "turn:progress",
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
