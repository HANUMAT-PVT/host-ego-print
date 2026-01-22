const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostego", {
    /** Returns list of printers: { name, displayName, description, status, isDefault } */
    getPrinters: () => ipcRenderer.invoke("GET_PRINTERS"),
    /**
     * Print job. Matches Printego Partner frontend API.
     * options: {
     *   images_urls: string[]   (required) – image, PDF, and document URLs from print_files
     *   quantity: number        (default 1) – copies
     *   color_mode: 'color'|'black'  (default 'color')
     *   deviceName?: string    – printer name (or use printerName)
     *   printerName?: string   – alias for deviceName
     *   file_types?: string[]  – optional, same length as images_urls; e.g. 'image','pdf','doc','docx','xls','xlsx' – improves file type detection
     * }
     * Returns { success, message? } or { success: false, error }
     */
    print: (options) => ipcRenderer.invoke("PRINT_JOB", options),
    
    /**
     * Get supported file types for printing
     * Returns array of supported file extensions and MIME types
     */
    getSupportedFileTypes: () => ipcRenderer.invoke("GET_SUPPORTED_FILE_TYPES"),
    
    /**
     * Get app capabilities
     * Returns object with capability flags
     */
    getCapabilities: () => ipcRenderer.invoke("GET_CAPABILITIES"),
});
