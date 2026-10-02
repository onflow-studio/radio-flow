const { contextBridge, ipcRenderer } = require("electron");

function listen(channel, listener) {
  const handler = () => listener();
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("flow", {
  // Synchronous, like the localStorage the web radio used.
  get: (key) => ipcRenderer.sendSync("store:get", key),
  set: (key, value) => ipcRenderer.send("store:set", key, value),
  status: (state) => ipcRenderer.send("status", state),
  resize: (height) => ipcRenderer.send("resize", height),
  hide: () => ipcRenderer.send("hide"),
  onToggle: (listener) => listen("toggle", listener),
  onShown: (listener) => listen("shown", listener),
});
