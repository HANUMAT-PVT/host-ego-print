const { app, BrowserWindow, ipcMain } = require("electron");
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

/** Build HTML for printing a single image that fills the page */
function buildPrintImageHtml(imageDataUrl) {
    return `<!DOCTYPE html><html><head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: white; }
        img { 
            width: 100%; 
            height: 100vh; 
            object-fit: contain;
            display: block;
        }
    </style></head><body><img src="${imageDataUrl}" /></body></html>`;
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
 * Capture PDF pages as images using Electron's capturePage
 * This is the key fix - we screenshot the PDF and print the screenshot
 */
async function capturePdfAsImages(pdfUrl) {
    const images = [];
    
    // Create a window to render the PDF - MUST be visible for proper rendering
    const pdfWindow = new BrowserWindow({
        show: true,  // Must be visible!
        x: -2000,    // Off-screen but still rendered
        y: -2000,
        width: 794,  // A4 width at 96 DPI
        height: 1123, // A4 height at 96 DPI
        webPreferences: {
            sandbox: false,
        },
    });

    try {
        // Load the PDF
        await pdfWindow.loadURL(pdfUrl);
        
        // Wait for PDF to fully render
        await new Promise(r => setTimeout(r, 4000));

        // Get total pages using PDF.js viewer's internal API
        let totalPages = 1;
        try {
            totalPages = await pdfWindow.webContents.executeJavaScript(`
                (function() {
                    // Try to get page count from Chromium's PDF viewer
                    const viewer = document.querySelector('embed[type="application/pdf"]');
                    if (viewer && viewer.postMessage) {
                        return 1; // Can't easily get page count, assume 1 for now
                    }
                    // Check if PDFViewerApplication exists (Firefox-style viewer)
                    if (typeof PDFViewerApplication !== 'undefined' && PDFViewerApplication.pdfDocument) {
                        return PDFViewerApplication.pdfDocument.numPages;
                    }
                    return 1;
                })();
            `);
        } catch (e) {
            totalPages = 1;
        }

        // Capture each page
        for (let page = 1; page <= totalPages; page++) {
            // Navigate to page if multi-page (for Chromium PDF viewer)
            if (page > 1) {
                try {
                    await pdfWindow.webContents.executeJavaScript(`
                        if (typeof PDFViewerApplication !== 'undefined') {
                            PDFViewerApplication.page = ${page};
                        }
                    `);
                    await new Promise(r => setTimeout(r, 1000));
                } catch (e) {}
            }

            // Capture the page as an image
            const image = await pdfWindow.webContents.capturePage();
            const pngBuffer = image.toPNG();
            
            // Save to temp file
            const tempPath = path.join(app.getPath("temp"), `pdf_page_${Date.now()}_${page}.png`);
            fs.writeFileSync(tempPath, pngBuffer);
            images.push(tempPath);
        }
    } finally {
        pdfWindow.close();
    }

    return images;
}

async function printJob(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const isColor = String(color_mode || "color").toLowerCase() === "color";

    // Create print window
    const printWindow = new BrowserWindow({
        show: false,
        width: 794,
        height: 1123,
        webPreferences: {
            sandbox: false,
        },
    });

    const tempFiles = []; // Track temp files for cleanup

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
                const url = urls[i];

                if (isPdf(job, url, i)) {
                    // 🎯 PDF: Capture as image first, then print the image
                    console.log("Converting PDF to image:", url);
                    const pdfImages = await capturePdfAsImages(url);
                    tempFiles.push(...pdfImages);

                    for (const imgPath of pdfImages) {
                        const loadPromise = new Promise((resolve) => {
                            printWindow.webContents.once("did-finish-load", resolve);
                        });

                        // Load the captured image
                        const html = buildImageHtml([`file://${imgPath}`]);
                        await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

                        await Promise.race([
                            loadPromise,
                            new Promise((_, rej) => setTimeout(() => rej(new Error("Load timed out")), 15000)),
                        ]);

                        // Wait for image to load
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

                        // Print
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

        // Cleanup temp files
        for (const tempFile of tempFiles) {
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch (e) {}
        }
    } catch (error) {
        printWindow.close();
        // Cleanup temp files on error too
        for (const tempFile of tempFiles) {
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch (e) {}
        }
        throw error;
    }
}

app.whenReady().then(createWindow);
