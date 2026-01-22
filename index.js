const { app, BrowserWindow, ipcMain, dialog } = require("electron");
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
            if (ft === type || ft.includes(type)) return true;
        }
    }
    
    // Fallback to URL extension check
    return isDocumentUrl(url);
}

/** Download file from URL */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith("https") ? https : http;
        const file = fs.createWriteStream(destPath);
        
        protocol.get(url, (response) => {
            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                return reject(new Error(`Download failed: ${response.statusCode}`));
            }
            
            response.pipe(file);
            
            file.on("finish", () => {
                file.close();
                resolve(destPath);
            });
        }).on("error", (err) => {
            file.close();
            fs.unlinkSync(destPath);
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

    if (process.platform === "darwin" && app.dock) {
        app.dock.setIcon(iconPath);
    }
}

ipcMain.handle("GET_PRINTERS", async () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        return getPrintersList(mainWindow.webContents);
    }
    return [];
});

ipcMain.handle("PRINT_JOB", async (_event, job) => {
    try {
        await printJob(job);
        return { success: true, message: "Print job completed successfully" };
    } catch (err) {
        console.error("Print failed", err);
        return { success: false, error: err.message };
    }
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
                const pdf = await pdfjsLib.getDocument('${pdfUrl}').promise;
                document.getElementById('loading').style.display = 'none';
                
                const container = document.getElementById('pages');
                
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
                }
                
                // Signal that rendering is complete
                window.pdfRendered = true;
                console.log('PDF rendered:', pdf.numPages, 'pages');
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

async function printJob(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    // Check if any URL is a document and LibreOffice is required
    const hasDocuments = images_urls.some((url, i) => isDocument(job, url, i));
    if (hasDocuments && !isLibreOfficeInstalled()) {
        const errorMsg = "LibreOffice Required\n\nTo print Word or Excel files, please install LibreOffice.\n\nDownload: https://www.libreoffice.org/download/";
        dialog.showErrorBox("LibreOffice Required", errorMsg);
        throw new Error("LibreOffice is not installed. Please install it to print documents.");
    }

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const isColor = String(color_mode || "color").toLowerCase() === "color";

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

        for (let q = 0; q < qty; q++) {
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i];
                let tempFilePath = null;

                // 📄 Handle documents (DOCX, XLSX, etc.) - Convert to PDF first
                if (isDocument(job, url, i)) {
                    console.log("🛠 Document detected, converting to PDF:", url);
                    
                    try {
                        // Download the document
                        const ext = url.match(/\.(docx?|xlsx?|pptx?|odt|ods|odp)($|[?#])/i)?.[1] || "docx";
                        const downloadPath = path.join(tempDir, `document-${i}.${ext}`);
                        console.log("Downloading document to:", downloadPath);
                        await downloadFile(url, downloadPath);
                        
                        // Convert to PDF using LibreOffice
                        console.log("Converting to PDF with LibreOffice...");
                        const pdfPath = await convertToPDF(downloadPath, tempDir);
                        console.log("Converted to PDF:", pdfPath);
                        
                        // Update URL to point to converted PDF
                        url = "file://" + pdfPath;
                        tempFilePath = downloadPath; // Mark for cleanup
                        
                        // Now treat it as a PDF for printing
                    } catch (conversionError) {
                        console.error("Document conversion failed:", conversionError);
                        throw new Error(`Failed to convert document: ${conversionError.message}`);
                    }
                }

                if (isPdf(job, url, i) || isDocument(job, urls[i], i)) {
                    // 🎯 PDF: Use PDF.js in browser to render to canvas, then print
                    console.log("Rendering PDF with PDF.js:", url);

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

                    console.log("Printing PDF...");
                    await doPrint(printWindow.webContents, printOpts);
                    console.log("PDF printed successfully");

                } else {
                    // Regular image printing
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

                    await doPrint(printWindow.webContents, printOpts);
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
