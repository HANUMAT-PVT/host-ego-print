const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostego", {
    /** Returns list of printers: { name, displayName, description, status, isDefault } */
    getPrinters: () => ipcRenderer.invoke("GET_PRINTERS"),
    /**
     * Print job. Matches Printego Partner frontend API.
     * options: {
     *   images_urls: string[]   (required) – image and/or PDF URLs from print_files
     *   quantity: number        (default 1) – copies
     *   color_mode: 'color'|'black'  (default 'color')
     *   deviceName?: string    – printer name (or use printerName)
     *   printerName?: string   – alias for deviceName
     *   file_types?: string[]  – optional, same length as images_urls; e.g. 'image','pdf','application/pdf' – improves PDF detection when URL has no .pdf
     * }
     * Returns { success, message? } or { success: false, error }
     */
    print: (options) => ipcRenderer.invoke("PRINT_JOB", options),
});
