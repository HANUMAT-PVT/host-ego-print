const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");

// Mitigate Windows cache errors
if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
    const userDataPath = path.join(appData, "HostegoPrint");
    try {
        if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
        app.setPath("userData", userDataPath);
    } catch (e) {
        console.warn("Could not set userData path:", e.message);
    }
}

let mainWindow;

/** Get printer list */
async function getPrintersList(webContents) {
    if (!webContents) return [];
    try {
        if (typeof webContents.getPrintersAsync === "function") {
            return await webContents.getPrintersAsync();
        }
        if (typeof webContents.getPrinters === "function") {
            return webContents.getPrinters();
        }
    } catch (e) {
        console.warn("getPrinters failed:", e?.message || e);
    }
    return [];
}

function createWindow() {
    let iconPath;
    if (process.platform === "darwin") {
        const icnsPath = path.join(__dirname, "assets/icon.icns");
        const pngPath = path.join(__dirname, "assets/icon.png");
        iconPath = fs.existsSync(icnsPath) ? icnsPath : pngPath;
    } else if (process.platform === "win32") {
        iconPath = path.join(__dirname, "assets/favicon.ico");
    } else {
        iconPath = path.join(__dirname, "assets/icon.png");
    }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: iconPath,
        title: "Hostego Print",
        webPreferences: {
            preload: __dirname + "/preload.js",
        },
    });

    mainWindow.loadURL("https://hostego.in/printego-partner");

    // Open DevTools for debugging (remove in production)
    // mainWindow.webContents.openDevTools();

    // Inject script to extend supported file types in web app
    mainWindow.webContents.on('did-finish-load', () => {
        console.log("Web page loaded, injecting capabilities...");

        mainWindow.webContents.executeJavaScript(`
            // Extend the web app to support document files
            console.log('%c🖨️ Hostego Desktop Print Client Loaded', 'color: #4CAF50; font-weight: bold; font-size: 14px;');
            
            if (window.hostego && window.hostego.getCapabilities) {
                window.hostego.getCapabilities().then(caps => {
                    console.log('%c📋 Desktop Capabilities:', 'color: #2196F3; font-weight: bold;', caps);
                    
                    // Store capabilities globally so web app can check
                    window.hostegoCapabilities = caps;
                    
                    // Dispatch event for web app to listen to
                    window.dispatchEvent(new CustomEvent('hostego:capabilities', { 
                        detail: caps 
                    }));
                    
                    // Override the print function to log what's being sent
                    if (window.hostego && window.hostego.print) {
                        const originalPrint = window.hostego.print;
                        window.hostego.print = function(options) {
                            console.log('%c📤 Print job requested:', 'color: #FF9800; font-weight: bold;', options);
                            return originalPrint(options);
                        };
                    }
                }).catch(err => {
                    console.error('Failed to get capabilities:', err);
                });
            } else {
                console.warn('⚠️ hostego.getCapabilities not available');
            }
        `).catch(err => {
            console.log('Script injection failed:', err.message);
        });
    });

    if (process.platform === "darwin" && app.dock) {
        app.dock.setIcon(iconPath);
    }

    // Create application menu
    const template = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Open Hostego Partner',
                    click: () => {
                        mainWindow.loadURL("https://hostego.in/printego-partner");
                    }
                },
                {
                    label: 'Open Test Page',
                    click: () => {
                        mainWindow.loadFile(path.join(__dirname, 'test-document-print.html'));
                    }
                },
                { type: 'separator' },
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => {
                        mainWindow.reload();
                    }
                },
                {
                    label: 'Toggle DevTools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => {
                        mainWindow.webContents.toggleDevTools();
                    }
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Help',
            submenu: []
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

ipcMain.handle("GET_PRINTERS", async () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        const printers = await getPrintersList(mainWindow.webContents);
        // Return printers with status information
        // Frontend should check status before allowing print
        return printers.map(p => ({
            ...p,
            isAvailable: !String(p.status || '').toLowerCase().includes('offline') && 
                        !String(p.status || '').toLowerCase().includes('unavailable') &&
                        !String(p.status || '').toLowerCase().includes('error')
        }));
    }
    return [];
});

ipcMain.handle("PRINT_JOB", async (event, job) => {
    const jobId = job._jobId || Date.now();
    const { _jobId, ...printJobData } = job;

    // Helper to send progress updates
    const sendProgress = (progress) => {
        if (event.sender && !event.sender.isDestroyed()) {
            event.sender.send('PRINT_PROGRESS', {
                jobId,
                ...progress
            });
        }
    };

    // Helper to send success callback when all prints are done
    const sendSuccess = (data) => {
        if (event.sender && !event.sender.isDestroyed()) {
            const successData = {
                jobId,
                order_id: printJobData.order_id,
                printerName: printJobData.deviceName,
                ...data
            };
            console.log('Sending PRINT_SUCCESSFULLY_DONE event:', JSON.stringify(successData, null, 2));
            event.sender.send('PRINT_SUCCESSFULLY_DONE', successData);
        } else {
            console.warn('Cannot send PRINT_SUCCESSFULLY_DONE: event.sender is destroyed or unavailable');
        }
    };

    // Helper to send error callback for printer errors
    const sendError = (error) => {
        if (event.sender && !event.sender.isDestroyed()) {
            const errorData = {
                jobId,
                order_id: printJobData.order_id,
                error: error.message || error,
                errorType: error.errorType || 'printer_error'
            };
            console.log('Sending PRINT_ERROR event:', JSON.stringify(errorData, null, 2));
            event.sender.send('PRINT_ERROR', errorData);
        } else {
            console.warn('Cannot send PRINT_ERROR: event.sender is destroyed or unavailable');
        }
    };

    try {
        await printJob(printJobData, sendProgress, sendSuccess, sendError);
        sendProgress({
            fileIndex: -1,
            totalFiles: printJobData.images_urls?.length || 0,
            status: 'completed',
            message: 'Print job completed successfully'
        });
        return { success: true, message: "Print job completed successfully" };
    } catch (err) {
        console.error("Print failed", err);
        sendError(err);
        sendProgress({
            fileIndex: -1,
            totalFiles: printJobData.images_urls?.length || 0,
            status: 'error',
            message: err.message
        });
        return { success: false, error: err.message };
    }
});

ipcMain.handle("GET_SUPPORTED_FILE_TYPES", async () => {
    return [
        "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
        "application/pdf", "pdf"
    ];
});

ipcMain.handle("GET_CAPABILITIES", async () => {
    return {
        version: "1.0.0",
        supportsImages: true,
        supportsPDF: true,
        supportsDocuments: false,
        libreOfficeInstalled: false,
        supportedExtensions: ["jpg", "jpeg", "png", "gif", "webp", "pdf"]
    };
});

/** Check if URL is a PDF */
function isPdfUrl(url) {
    return /\.pdf($|[?#])/i.test(String(url || ""));
}

function isPdf(job, url, index) {
    const ft = job.file_types && Array.isArray(job.file_types) ? String(job.file_types[index] || "").toLowerCase() : "";
    if (ft && (ft === "pdf" || ft === "application/pdf" || ft.includes("pdf"))) return true;
    if (ft && !ft.includes("pdf")) return false;
    return isPdfUrl(url);
}



/** Build HTML for images */
function buildImageHtml(urls) {
    const body = urls
        .map((u) => `<div class="page"><img src="${u}" /></div>`)
        .join("");
    return `<!DOCTYPE html><html><head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
        .page { 
            width: 100%; 
            height: 100vh; 
            page-break-after: always; 
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .page:last-child { page-break-after: auto; }
        img { max-width: 100%; max-height: 100%; object-fit: contain; }
    </style></head><body>${body}</body></html>`;
}

/**
 * Create HTML that renders PDF using PDF.js in browser (client-side rendering)
 * This renders the PDF to canvas in the browser, avoiding GPU issues
 */
function buildPdfRenderHtml(pdfUrl) {
    // Escape single quotes in URL for JavaScript string
    const escapedUrl = pdfUrl.replace(/'/g, "\\'");

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        @media print { 
            .page { page-break-after: always; }
            .page:last-child { page-break-after: auto; }
        }
        html, body { background: white; }
        .page { 
            width: 210mm; 
            min-height: 297mm;
            display: flex;
            justify-content: center;
            align-items: center;
            background: white;
        }
        canvas { 
            max-width: 100%; 
            max-height: 297mm;
        }
        #loading { 
            position: fixed; 
            top: 50%; 
            left: 50%; 
            transform: translate(-50%, -50%);
            font-family: Arial, sans-serif;
            font-size: 18px;
        }
    </style>
</head>
<body>
    <div id="loading">Loading PDF...</div>
    <div id="pages"></div>
    <script>
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        
        async function renderPDF() {
            try {
                console.log('Loading PDF from:', '${escapedUrl}');
                const pdf = await pdfjsLib.getDocument({
                    url: '${escapedUrl}',
                    isEvalSupported: false
                }).promise;
                document.getElementById('loading').style.display = 'none';
                
                const container = document.getElementById('pages');
                console.log('PDF loaded, pages:', pdf.numPages);
                
                for (let i = 1; i <= pdf.numPages; i++) {
                    const page = await pdf.getPage(i);
                    const scale = 2; // High quality
                    const viewport = page.getViewport({ scale });
                    
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    
                    await page.render({
                        canvasContext: context,
                        viewport: viewport
                    }).promise;
                    
                    const pageDiv = document.createElement('div');
                    pageDiv.className = 'page';
                    pageDiv.appendChild(canvas);
                    container.appendChild(pageDiv);
                    console.log('Rendered page', i);
                }
                
                // Signal that rendering is complete
                window.pdfRendered = true;
                console.log('PDF rendered successfully:', pdf.numPages, 'pages');
            } catch (error) {
                document.getElementById('loading').textContent = 'Error: ' + error.message;
                console.error('PDF render error:', error);
                window.pdfError = error.message;
            }
        }
        
        renderPDF();
    </script>
</body>
</html>`;
}

async function printJob(job, sendProgress = null, sendSuccess = null, sendError = null) {
    const { images_urls, quantity, color_mode, color_modes, order_id } = job;
    const deviceName = job.deviceName || job.printerName;

    console.log("=== PRINT JOB START ===");
    console.log("Job data:", JSON.stringify(job, null, 2));

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const urls = images_urls;
    // Files are already expanded by quantity, so each file should be printed once
    // quantity parameter is now ignored since files are pre-expanded
    const totalFiles = urls.length;

    // Support per-file color_mode via color_modes array
    // If color_modes array is provided, use it; otherwise fall back to global color_mode or default
    const getFileColorMode = (index) => {
        if (color_modes && Array.isArray(color_modes) && color_modes[index] !== undefined) {
            return String(color_modes[index] || "color").toLowerCase();
        }
        return String(color_mode || "color").toLowerCase();
    };

    // Log file type summary
    console.log("=== FILE TYPE ANALYSIS ===");
    urls.forEach((url, idx) => {
        const isPdfFile = isPdf(job, url, idx);
        const fileType = job.file_types?.[idx] || 'unknown';
        console.log(`File ${idx + 1}: type=${fileType}, isPdf=${isPdfFile}, url=${url.substring(0, 60)}...`);
    });
    console.log("==========================");

    // Create print window - visible for proper rendering
    const printWindow = new BrowserWindow({
        show: true,
        x: 0,
        y: 0,
        width: 794,
        height: 1123,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
            sandbox: false,
            webSecurity: false, // Allow loading PDF from any URL
        },
    });

    async function getTargetPrinter() {
        const printers = await getPrintersList(printWindow.webContents);
        if (printers.length === 0) {
            throw new Error("No printers found. Please connect a printer and try again.");
        }
        
        // Filter out offline/unavailable printers
        const availablePrinters = printers.filter(p => {
            // Check if printer status indicates it's available
            // Status can be: 'idle', 'printing', 'stopped', 'offline', etc.
            const status = String(p.status || '').toLowerCase();
            const isOffline = status.includes('offline') || status.includes('unavailable') || status.includes('error');
            return !isOffline;
        });
        
        if (availablePrinters.length === 0) {
            throw new Error("No printers are currently available. Please check that your printer is connected, powered on, and online.");
        }
        
        let targetPrinter = null;
        
        if (!deviceName) {
            // Find default printer from available printers
            const def = availablePrinters.find((p) => p.isDefault) || availablePrinters[0];
            if (!def) {
                throw new Error("No default printer found. Please select a printer.");
            }
            targetPrinter = def.name;
        } else {
            // Find the specified printer in available printers
            const found = availablePrinters.find((p) => p.name === deviceName);
            if (!found) {
                // Check if printer exists but is offline
                const existsButOffline = printers.some((p) => p.name === deviceName);
                if (existsButOffline) {
                    throw new Error(`Printer "${deviceName}" is offline or unavailable. Please check the printer connection and try again.`);
                }
                throw new Error(`Printer "${deviceName}" not found. Please select a different printer.`);
            }
            targetPrinter = deviceName;
        }
        
        // Double-check the printer is still available (status might have changed)
        const finalCheck = printers.find((p) => p.name === targetPrinter);
        if (finalCheck) {
            const status = String(finalCheck.status || '').toLowerCase();
            if (status.includes('offline') || status.includes('unavailable') || status.includes('error')) {
                throw new Error(`Printer "${targetPrinter}" is currently offline or unavailable. Please check the printer and try again.`);
            }
        }
        
        console.log(`Selected printer: ${targetPrinter} (status: ${finalCheck?.status || 'unknown'})`);
        return targetPrinter;
    }

    function doPrint(contents, opts, fileIndex = -1) {
        return new Promise((resolve, reject) => {
            // Verify printer is still available before printing
            getPrintersList(contents).then(printers => {
                const printerName = opts.deviceName;
                if (printerName) {
                    const printer = printers.find(p => p.name === printerName);
                    if (printer) {
                        const status = String(printer.status || '').toLowerCase();
                        if (status.includes('offline') || status.includes('unavailable') || status.includes('error')) {
                            const error = new Error(`Printer "${printerName}" is offline or unavailable. Please check the printer connection and try again.`);
                            error.errorType = 'printer_offline';
                            error.fileIndex = fileIndex;
                            return reject(error);
                        }
                    } else {
                        const error = new Error(`Printer "${printerName}" not found. Please check the printer connection.`);
                        error.errorType = 'printer_not_found';
                        error.fileIndex = fileIndex;
                        return reject(error);
                    }
                }
                
                // Proceed with printing
                contents.print(opts, (success, reason) => {
                    if (success) {
                        // Verify print actually succeeded by checking printer status again
                        getPrintersList(contents).then(printers => {
                            if (printerName) {
                                const printer = printers.find(p => p.name === printerName);
                                if (printer) {
                                    const status = String(printer.status || '').toLowerCase();
                                    if (status.includes('offline') || status.includes('unavailable')) {
                                        console.warn(`Warning: Printer "${printerName}" status indicates offline after print, but print reported success.`);
                                    }
                                }
                            }
                            resolve();
                        }).catch(() => {
                            // If we can't verify, still resolve (print reported success)
                            resolve();
                        });
                    } else {
                        // Parse common printer error messages
                        const errorMessage = reason || "Print failed";
                        let errorType = 'printer_error';
                        let userFriendlyMessage = errorMessage;

                        // Check for common printer errors
                        const lowerReason = String(errorMessage).toLowerCase();
                        if (lowerReason.includes('paper') || lowerReason.includes('sheet') || lowerReason.includes('out of paper')) {
                            errorType = 'no_paper';
                            userFriendlyMessage = 'No paper/sheets present in the printer. Please add paper and try again.';
                        } else if (lowerReason.includes('ink') || lowerReason.includes('toner') || lowerReason.includes('cartridge')) {
                            errorType = 'no_ink';
                            userFriendlyMessage = 'Printer ink/toner is low or empty. Please check your printer.';
                        } else if (lowerReason.includes('offline') || lowerReason.includes('not connected') || lowerReason.includes('unavailable')) {
                            errorType = 'printer_offline';
                            userFriendlyMessage = 'Printer is offline or not connected. Please check the printer connection and try again.';
                        } else if (lowerReason.includes('jam') || lowerReason.includes('jammed')) {
                            errorType = 'paper_jam';
                            userFriendlyMessage = 'Paper jam detected. Please clear the paper jam and try again.';
                        } else if (lowerReason.includes('cover') || lowerReason.includes('open')) {
                            errorType = 'printer_cover_open';
                            userFriendlyMessage = 'Printer cover is open. Please close the cover and try again.';
                        }

                        const error = new Error(userFriendlyMessage);
                        error.errorType = errorType;
                        error.originalReason = reason;
                        error.fileIndex = fileIndex;
                        reject(error);
                    }
                });
            }).catch(err => {
                const error = new Error(`Failed to verify printer status: ${err.message}`);
                error.errorType = 'printer_verification_failed';
                error.fileIndex = fileIndex;
                reject(error);
            });
        });
    }

    try {
        // First, verify printers are available before starting
        const initialPrinters = await getPrintersList(printWindow.webContents);
        if (initialPrinters.length === 0) {
            throw new Error("No printers found. Please connect a printer and try again.");
        }
        
        const availablePrinters = initialPrinters.filter(p => {
            const status = String(p.status || '').toLowerCase();
            return !status.includes('offline') && !status.includes('unavailable') && !status.includes('error');
        });
        
        if (availablePrinters.length === 0) {
            throw new Error("No printers are currently available. Please check that your printer is connected, powered on, and online.");
        }
        
        // Get the target printer (this will also validate it's available)
        const targetPrinter = await getTargetPrinter();

        // Files are already expanded by quantity, so print each file once
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];

            // Get color mode for this specific file
            const fileColorMode = getFileColorMode(i);
            const isColor = fileColorMode === "color";

            console.log(`File ${i + 1}/${totalFiles}: color_mode=${fileColorMode}, isColor=${isColor}`);

            // Determine file type
            const isPdfFile = isPdf(job, url, i);
            const isImageFile = !isPdfFile;

            console.log(`File ${i + 1}: URL=${url.substring(0, 50)}... | isPdf=${isPdfFile} | isImage=${isImageFile}`);

            // Send progress: Starting file
            if (sendProgress) {
                let fileTypeLabel = isPdfFile ? 'PDF' : 'image';
                sendProgress({
                    fileIndex: i,
                    totalFiles: totalFiles,
                    status: 'rendering',
                    message: `Processing ${fileTypeLabel} ${i + 1} of ${totalFiles}...`,
                    url: url
                });
            }

            if (isPdfFile) {
                // 🎯 PDF: Use PDF.js in browser to render to canvas, then print
                console.log("Rendering PDF with PDF.js:", url);

                if (sendProgress) {
                    sendProgress({
                        fileIndex: i,
                        totalFiles: totalFiles,
                        status: 'rendering',
                        message: `Rendering PDF ${i + 1} of ${totalFiles}...`,
                        url: url
                    });
                }

                const loadPromise = new Promise((resolve) => {
                    printWindow.webContents.once("did-finish-load", resolve);
                });

                // Load HTML that uses PDF.js to render PDF to canvas
                const html = buildPdfRenderHtml(url);
                await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

                await Promise.race([
                    loadPromise,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Load timed out")), 30000)),
                ]);

                // Wait for PDF.js to finish rendering
                console.log("Waiting for PDF.js to render...");
                await printWindow.webContents.executeJavaScript(`
                        new Promise((resolve, reject) => {
                            let checks = 0;
                            const check = () => {
                                checks++;
                                if (window.pdfRendered) {
                                    resolve();
                                } else if (window.pdfError) {
                                    reject(new Error(window.pdfError));
                                } else if (checks > 100) {
                                    reject(new Error('PDF render timeout'));
                                } else {
                                    setTimeout(check, 200);
                                }
                            };
                            check();
                        });
                    `);

                // Extra wait for canvas rendering to complete
                await new Promise((r) => setTimeout(r, 1000));

                // Print
                const printOpts = {
                    silent: true,
                    printBackground: true,
                    color: isColor,
                    copies: 1,
                    deviceName: targetPrinter,

                    margins: {
                        marginType: "none",
                    },

                    pageSize: {
                        width: 210000,   // microns
                        height: 297000,
                    },

                    scaleFactor: 100,
                };

                if (targetPrinter) printOpts.deviceName = targetPrinter;

                if (sendProgress) {
                    sendProgress({
                        fileIndex: i,
                        totalFiles: totalFiles,
                        status: 'printing',
                        message: `Printing file ${i + 1} of ${totalFiles}...`,
                        url: url
                    });
                }

                console.log("Printing PDF...");
                try {
                    await doPrint(printWindow.webContents, printOpts, i);
                    console.log("PDF printed successfully");

                    if (sendProgress) {
                        sendProgress({
                            fileIndex: i,
                            totalFiles: totalFiles,
                            status: 'completed',
                            message: `File ${i + 1} of ${totalFiles} printed successfully`,
                            url: url
                        });
                    }
                } catch (printError) {
                    console.error(`Print error for file ${i + 1}:`, printError);
                    if (sendError) {
                        sendError(printError);
                    }
                    throw printError; // Re-throw to stop the loop
                }

            } else {
                // Regular image printing
                if (sendProgress) {
                    sendProgress({
                        fileIndex: i,
                        totalFiles: totalFiles,
                        status: 'rendering',
                        message: `Loading image ${i + 1} of ${totalFiles}...`,
                        url: url
                    });
                }

                const loadPromise = new Promise((resolve) => {
                    printWindow.webContents.once("did-finish-load", resolve);
                });

                const html = buildImageHtml([url]);
                await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

                await Promise.race([
                    loadPromise,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Load timed out")), 15000)),
                ]);

                await printWindow.webContents.executeJavaScript(`
                        new Promise((resolve) => {
                            const imgs = document.images;
                            if (imgs.length === 0) return resolve();
                            let left = imgs.length;
                            const done = () => { if (--left === 0) resolve(); };
                            for (let i = 0; i < imgs.length; i++) {
                                if (imgs[i].complete) done();
                                else { imgs[i].onload = done; imgs[i].onerror = done; }
                            }
                        });
                    `);
                await new Promise((r) => setTimeout(r, 300));

                const printOpts = {
                    silent: true,
                    printBackground: true,
                    color: isColor,
                    copies: 1,
                    margins: { marginType: "none" },
                    pageSize: "A4",
                };
                if (targetPrinter) printOpts.deviceName = targetPrinter;

                if (sendProgress) {
                    sendProgress({
                        fileIndex: i,
                        totalFiles: totalFiles,
                        status: 'printing',
                        message: `Printing image ${i + 1} of ${totalFiles}...`,
                        url: url
                    });
                }

                try {
                    await doPrint(printWindow.webContents, printOpts, i);
                    console.log("Image printed successfully");

                    if (sendProgress) {
                        sendProgress({
                            fileIndex: i,
                            totalFiles: totalFiles,
                            status: 'completed',
                            message: `File ${i + 1} of ${totalFiles} printed successfully`,
                            url: url
                        });
                    }
                } catch (printError) {
                    console.error(`Print error for file ${i + 1}:`, printError);
                    if (sendError) {
                        sendError(printError);
                    }
                    throw printError; // Re-throw to stop the loop
                }
            }
        }

        // Verify printer is still available before marking as completed
        console.log('All files printed successfully, verifying printer status before sending success callback...');
        const finalPrinters = await getPrintersList(printWindow.webContents);
        const finalPrinterCheck = finalPrinters.find((p) => p.name === targetPrinter);
        
        if (!finalPrinterCheck) {
            const error = new Error(`Printer "${targetPrinter}" is no longer available. Print job may not have completed successfully.`);
            error.errorType = 'printer_unavailable';
            if (sendError) {
                sendError(error);
            }
            throw error;
        }
        
        const finalStatus = String(finalPrinterCheck.status || '').toLowerCase();
        if (finalStatus.includes('offline') || finalStatus.includes('unavailable') || finalStatus.includes('error')) {
            const error = new Error(`Printer "${targetPrinter}" is offline or unavailable. Print job may not have completed successfully.`);
            error.errorType = 'printer_offline';
            if (sendError) {
                sendError(error);
            }
            throw error;
        }
        
        // All files printed successfully and printer is confirmed available - send success callback
        console.log('Printer status verified, sending success callback...');
        if (sendSuccess) {
            sendSuccess({
                totalFiles: totalFiles,
                message: `All ${totalFiles} file(s) printed successfully`,
                order_id: job.order_id,
                printerName: targetPrinter
            });
        } else {
            console.warn('sendSuccess callback is not available');
        }

        printWindow.close();
    } catch (error) {
        printWindow.close();
        // Error already sent via sendError in the catch blocks above
        throw error;
    }
}

app.whenReady().then(createWindow);
