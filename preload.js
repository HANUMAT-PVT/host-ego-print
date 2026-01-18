const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostego", {
    /** Returns list of printers: { name, displayName, description, status, isDefault } */
    getPrinters: () => ipcRenderer.invoke("GET_PRINTERS"),
    /** Print job. options: { images_urls, quantity, color_mode, deviceName? }. images_urls can contain image URLs and/or PDF URLs (.pdf); each is detected by URL. Returns { success, message? } or { success: false, error } */
    print: (options) => ipcRenderer.invoke("PRINT_JOB", options),
});
