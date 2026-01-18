const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostego", {
    print: (options) => ipcRenderer.send("PRINT_JOB", options),
});
