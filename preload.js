const { contextBridge, ipcRenderer } = require("electron");

// Store progress callbacks
let printProgressCallbacks = new Map();
let printJobIdCounter = 0;

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
     *   onProgress?: (progress) => void  – optional callback for print progress
     * }
     * Returns { success, message? } or { success: false, error }
     * 
     * Progress callback receives: { fileIndex, totalFiles, status, message, url }
     * status: 'downloading' | 'converting' | 'rendering' | 'printing' | 'completed' | 'error'
     */
    print: (options) => {
        const jobId = ++printJobIdCounter;
        const { onProgress, ...printOptions } = options;
        
        // Store progress callback if provided
        if (onProgress && typeof onProgress === 'function') {
            printProgressCallbacks.set(jobId, onProgress);
            
            // Listen for progress events
            const progressListener = (_event, progress) => {
                if (progress.jobId === jobId && printProgressCallbacks.has(jobId)) {
                    const callback = printProgressCallbacks.get(jobId);
                    callback(progress);
                    
                    // Remove callback if job is completed or errored
                    if (progress.status === 'completed' || progress.status === 'error') {
                        printProgressCallbacks.delete(jobId);
                        ipcRenderer.removeListener('PRINT_PROGRESS', progressListener);
                    }
                }
            };
            
            ipcRenderer.on('PRINT_PROGRESS', progressListener);
        }
        
        // Send print job with jobId
        return ipcRenderer.invoke("PRINT_JOB", { ...printOptions, _jobId: jobId });
    },
    
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

// Expose IPC event listeners for print success and error callbacks
contextBridge.exposeInMainWorld("electron", {
    ipcRenderer: {
        on: (channel, callback) => {
            // Whitelist allowed channels for security
            const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
            if (validChannels.includes(channel)) {
                ipcRenderer.on(channel, callback);
            } else {
                console.warn(`Channel ${channel} is not allowed`);
            }
        },
        removeListener: (channel, callback) => {
            const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
            if (validChannels.includes(channel)) {
                ipcRenderer.removeListener(channel, callback);
            }
        },
        removeAllListeners: (channel) => {
            const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
            if (validChannels.includes(channel)) {
                ipcRenderer.removeAllListeners(channel);
            }
        }
    }
});

// Also expose as electronAPI for compatibility
contextBridge.exposeInMainWorld("electronAPI", {
    on: (channel, callback) => {
        const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, callback);
        } else {
            console.warn(`Channel ${channel} is not allowed`);
        }
    },
    removeListener: (channel, callback) => {
        const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeListener(channel, callback);
        }
    },
    removeAllListeners: (channel) => {
        const validChannels = ['PRINT_PROGRESS', 'PRINT_SUCCESSFULLY_DONE', 'PRINT_ERROR'];
        if (validChannels.includes(channel)) {
            ipcRenderer.removeAllListeners(channel);
        }
    }
});
