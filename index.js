const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const https = require("https");
const http = require("http");

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

// LibreOffice paths
const LIBRE_OFFICE_PATHS = {
    win32: "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    darwin: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    linux: "/usr/bin/soffice"
};

/** Check if LibreOffice is installed */
function isLibreOfficeInstalled() {
    const libreOfficePath = LIBRE_OFFICE_PATHS[process.platform];
    if (!libreOfficePath) return false;
    return fs.existsSync(libreOfficePath);
}

/** Get LibreOffice executable path */
function getLibreOfficePath() {
    return LIBRE_OFFICE_PATHS[process.platform];
}

/** Check if URL is a document file */
function isDocumentUrl(url) {
    return /\.(docx?|xlsx?|pptx?|odt|ods|odp)($|[?#])/i.test(String(url || ""));
}

/** Check if file is a document based on job metadata or URL */
function isDocument(job, url, index) {
    const ft = job.file_types && Array.isArray(job.file_types)
        ? String(job.file_types[index] || "").toLowerCase()
        : "";

    // Check explicit file type
    if (ft) {
        const docTypes = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"];
        for (const type of docTypes) {
            if (ft === type || ft.includes(type)) {
                console.log(`Document detected via file_type: ${ft} (matches ${type})`);
                return true;
            }
        }
    }

    // Fallback to URL extension check
    const isDocByUrl = isDocumentUrl(url);
    if (isDocByUrl) {
        console.log(`Document detected via URL extension: ${url}`);
    }
    return isDocByUrl;
}

/** Download file from URL */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;
        const file = fs.createWriteStream(destPath);

        const handleResponse = (response) => {
            // Handle redirects
            if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
                file.close();
                fs.unlinkSync(destPath);
                const redirectUrl = response.headers.location;
                console.log("Following redirect to:", redirectUrl);
                return downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            }

            if (response.statusCode !== 200) {
                file.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                return reject(new Error(`Download failed with status: ${response.statusCode}`));
            }

            response.pipe(file);

            file.on("finish", () => {
                file.close();
                console.log("Download completed:", destPath);
                resolve(destPath);
            });

            file.on("error", (err) => {
                file.close();
                if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
                reject(err);
            });
        };

        protocol.get(url, handleResponse).on("error", (err) => {
            file.close();
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

/** Convert document to PDF using LibreOffice */
function convertToPDF(inputPath, outputDir) {
    return new Promise((resolve, reject) => {
        const libreOfficePath = getLibreOfficePath();

        execFile(
            libreOfficePath,
            [
                "--headless",
                "--convert-to",
                "pdf",
                "--outdir",
                outputDir,
                inputPath,
            ],
            (err, stdout, stderr) => {
                if (err) {
                    console.error("LibreOffice conversion error:", err);
                    console.error("stderr:", stderr);
                    return reject(new Error(`Conversion failed: ${err.message}`));
                }

                const pdfPath = path.join(
                    outputDir,
                    path.basename(inputPath).replace(/\.(docx?|xlsx?|pptx?|odt|ods|odp)$/i, ".pdf")
                );

                // Check if PDF was created
                if (!fs.existsSync(pdfPath)) {
                    return reject(new Error("PDF conversion failed - output file not found"));
                }

                resolve(pdfPath);
            }
        );
    });
}

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
                    
                    // Notify the page that we support documents
                    if (caps.supportsDocuments) {
                        console.log('%c✅ Document printing enabled (LibreOffice detected)', 'color: #4CAF50;');
                        
                        // Dispatch event for web app to listen to
                        window.dispatchEvent(new CustomEvent('hostego:capabilities', { 
                            detail: caps 
                        }));
                    }
                    
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
            submenu: [
                {
                    label: 'Check LibreOffice',
                    click: () => {
                        const installed = isLibreOfficeInstalled();
                        const message = installed
                            ? 'LibreOffice is installed and ready!\n\nPath: ' + getLibreOfficePath()
                            : 'LibreOffice is NOT installed.\n\nPlease install it to print documents.\n\nDownload: https://www.libreoffice.org/download/';

                        dialog.showMessageBox({
                            type: installed ? 'info' : 'warning',
                            title: 'LibreOffice Status',
                            message: message,
                            buttons: ['OK']
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

ipcMain.handle("GET_PRINTERS", async () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        return getPrintersList(mainWindow.webContents);
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

    try {
        await printJob(printJobData, sendProgress);
        sendProgress({
            fileIndex: -1,
            totalFiles: printJobData.images_urls?.length || 0,
            status: 'completed',
            message: 'Print job completed successfully'
        });
        return { success: true, message: "Print job completed successfully" };
    } catch (err) {
        console.error("Print failed", err);
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
    const baseTypes = [
        "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
        "application/pdf", "pdf"
    ];

    // Add document types if LibreOffice is installed
    if (isLibreOfficeInstalled()) {
        return [
            ...baseTypes,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // docx
            "application/msword", // doc
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // xlsx
            "application/vnd.ms-excel", // xls
            "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
            "application/vnd.ms-powerpoint", // ppt
            "application/vnd.oasis.opendocument.text", // odt
            "application/vnd.oasis.opendocument.spreadsheet", // ods
            "application/vnd.oasis.opendocument.presentation", // odp
            "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"
        ];
    }

    return baseTypes;
});

ipcMain.handle("GET_CAPABILITIES", async () => {
    return {
        version: "1.0.0",
        supportsImages: true,
        supportsPDF: true,
        supportsDocuments: isLibreOfficeInstalled(),
        libreOfficeInstalled: isLibreOfficeInstalled(),
        supportedExtensions: isLibreOfficeInstalled()
            ? ["jpg", "jpeg", "png", "gif", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"]
            : ["jpg", "jpeg", "png", "gif", "webp", "pdf"]
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

async function printJob(job, sendProgress = null) {
    const { images_urls, quantity, color_mode, color_modes } = job;
    const deviceName = job.deviceName || job.printerName;

    console.log("=== PRINT JOB START ===");
    console.log("Job data:", JSON.stringify(job, null, 2));

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    // Check if any URL is a document and LibreOffice is required
    const hasDocuments = images_urls.some((url, i) => {
        const isDoc = isDocument(job, url, i);
        console.log(`URL ${i}: ${url} -> isDocument: ${isDoc}`);
        return isDoc;
    });

    console.log("Has documents:", hasDocuments);
    console.log("LibreOffice installed:", isLibreOfficeInstalled());

    if (hasDocuments && !isLibreOfficeInstalled()) {
        const errorMsg = "LibreOffice Required\n\nTo print Word or Excel files, please install LibreOffice.\n\nDownload: https://www.libreoffice.org/download/";
        dialog.showErrorBox("LibreOffice Required", errorMsg);
        throw new Error("LibreOffice is not installed. Please install it to print documents.");
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
        const isDoc = isDocument(job, url, idx);
        const isPdfFile = isPdf(job, url, idx);
        const fileType = job.file_types?.[idx] || 'unknown';
        console.log(`File ${idx + 1}: type=${fileType}, isDoc=${isDoc}, isPdf=${isPdfFile}, url=${url.substring(0, 60)}...`);
    });
    console.log("==========================");

    // Create temporary directory for document conversions
    const tempDir = path.join(app.getPath("temp"), "hostego-print-" + Date.now());
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

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
        if (printers.length === 0) throw new Error("No printers found.");
        if (!deviceName) {
            const def = printers.find((p) => p.isDefault) || printers[0];
            return def ? def.name : null;
        }
        const found = printers.some((p) => p.name === deviceName);
        if (!found) throw new Error(`Printer "${deviceName}" not found.`);
        return deviceName;
    }

    function doPrint(contents, opts) {
        return new Promise((resolve, reject) => {
            contents.print(opts, (success, reason) => {
                if (success) resolve();
                else reject(new Error(reason || "Print failed"));
            });
        });
    }

    try {
        const targetPrinter = await getTargetPrinter();

        // Files are already expanded by quantity, so print each file once
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let tempFilePaths = []; // Track all temp files for this iteration
            let isConvertedDocument = false;
            
            // Get color mode for this specific file
            const fileColorMode = getFileColorMode(i);
            const isColor = fileColorMode === "color";
            
            console.log(`File ${i + 1}/${totalFiles}: color_mode=${fileColorMode}, isColor=${isColor}`);

                // Determine file type
                const isDoc = isDocument(job, url, i);
                const isPdfFileOriginal = isPdf(job, url, i);
                const isImageFile = !isDoc && !isPdfFileOriginal;

                console.log(`File ${i + 1}: URL=${url.substring(0, 50)}... | isDoc=${isDoc} | isPdf=${isPdfFileOriginal} | isImage=${isImageFile}`);

                // Send progress: Starting file
                if (sendProgress) {
                    let fileTypeLabel = 'file';
                    if (isDoc) fileTypeLabel = 'document';
                    else if (isPdfFileOriginal) fileTypeLabel = 'PDF';
                    else if (isImageFile) fileTypeLabel = 'image';

                    sendProgress({
                        fileIndex: i,
                        totalFiles: totalFiles,
                        status: 'downloading',
                        message: `Processing ${fileTypeLabel} ${i + 1} of ${totalFiles}...`,
                        url: url
                    });
                }

                // 📄 Handle documents (DOCX, XLSX, etc.) - Convert to PDF first
                if (isDoc) {
                    console.log("🛠 Document detected, converting to PDF:", url);

                    try {
                        // Download the document
                        const ext = url.match(/\.(docx?|xlsx?|pptx?|odt|ods|odp)($|[?#])/i)?.[1] || "docx";
                        const downloadPath = path.join(tempDir, `document-${i}.${ext}`);
                        console.log("Downloading document to:", downloadPath);

                        if (sendProgress) {
                            sendProgress({
                                fileIndex: i,
                                totalFiles: totalFiles,
                                status: 'downloading',
                                message: `Downloading document ${i + 1} of ${totalFiles}...`,
                                url: url
                            });
                        }

                        await downloadFile(url, downloadPath);
                        tempFilePaths.push(downloadPath);

                        // Convert to PDF using LibreOffice
                        console.log("Converting to PDF with LibreOffice...");

                        if (sendProgress) {
                            sendProgress({
                                fileIndex: i,
                                totalFiles: totalFiles,
                                status: 'converting',
                                message: `Converting document ${i + 1} of ${totalFiles} to PDF...`,
                                url: url
                            });
                        }

                        const pdfPath = await convertToPDF(downloadPath, tempDir);
                        console.log("Converted to PDF:", pdfPath);
                        tempFilePaths.push(pdfPath);

                        // Read the PDF file and convert to base64 data URL
                        console.log("Reading PDF file for data URL conversion...");
                        const pdfBuffer = fs.readFileSync(pdfPath);
                        const base64Pdf = pdfBuffer.toString('base64');
                        url = `data:application/pdf;base64,${base64Pdf}`;
                        console.log("Converted to data URL, size:", Math.round(base64Pdf.length / 1024), "KB");

                        isConvertedDocument = true; // Flag that this was converted

                        // Now treat it as a PDF for printing
                    } catch (conversionError) {
                        console.error("Document conversion failed:", conversionError);
                        if (sendProgress) {
                            sendProgress({
                                fileIndex: i,
                                totalFiles: totalFiles,
                                status: 'error',
                                message: `Failed to convert document: ${conversionError.message}`,
                                url: url
                            });
                        }
                        throw new Error(`Failed to convert document: ${conversionError.message}`);
                    }
                }

                // Check if it's a PDF (original or converted from document)
                // After conversion, url is a data URL, so check original URL or conversion flag
                const isPdfFile = isConvertedDocument || isPdf(job, urls[i], i);

                console.log(`File ${i + 1} after processing: isConvertedDocument=${isConvertedDocument}, isPdfFile=${isPdfFile}`);

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
                    await doPrint(printWindow.webContents, printOpts);
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

                    await doPrint(printWindow.webContents, printOpts);

                    if (sendProgress) {
                        sendProgress({
                            fileIndex: i,
                            totalFiles: totalFiles,
                            status: 'completed',
                            message: `File ${i + 1} of ${totalFiles} printed successfully`,
                            url: url
                        });
                    }
                }
        }

        printWindow.close();

        // Cleanup temporary files
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                console.log("Cleaned up temporary directory");
            }
        } catch (cleanupError) {
            console.warn("Failed to cleanup temp directory:", cleanupError);
        }
    } catch (error) {
        printWindow.close();

        // Cleanup temporary files on error
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch (cleanupError) {
            console.warn("Failed to cleanup temp directory:", cleanupError);
        }

        throw error;
    }
}

app.whenReady().then(createWindow);
