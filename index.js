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

/** Check file type from URL or file_types array */
function getFileType(job, url, index) {
    const urlStr = String(url || "").toLowerCase();
    const ft = job.file_types && Array.isArray(job.file_types) ? String(job.file_types[index] || "").toLowerCase() : "";
    
    // Check file_types array first
    if (ft) {
        if (ft === "pdf" || ft === "application/pdf" || ft.includes("pdf")) return "pdf";
        if (ft.includes("excel") || ft.includes("xlsx") || ft.includes("xls") || ft.includes("spreadsheet")) return "excel";
        if (ft.includes("word") || ft.includes("docx") || ft.includes("doc") || ft.includes("document")) return "word";
        if (ft.includes("csv")) return "csv";
        if (ft.includes("text") || ft.includes("txt")) return "text";
        if (ft.includes("image") || ft.includes("png") || ft.includes("jpg") || ft.includes("jpeg") || ft.includes("gif") || ft.includes("webp")) return "image";
    }
    
    // Check URL extension
    if (/\.pdf($|[?#])/i.test(urlStr)) return "pdf";
    if (/\.(xlsx?|xls)($|[?#])/i.test(urlStr)) return "excel";
    if (/\.(docx?|doc)($|[?#])/i.test(urlStr)) return "word";
    if (/\.csv($|[?#])/i.test(urlStr)) return "csv";
    if (/\.txt($|[?#])/i.test(urlStr)) return "text";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)($|[?#])/i.test(urlStr)) return "image";
    
    // Default to image for unknown types
    return "image";
}

/** Check if file is a document that needs to be converted to image */
function isDocument(job, url, index) {
    const type = getFileType(job, url, index);
    return type === "pdf" || type === "excel" || type === "word" || type === "csv" || type === "text";
}

function isImage(job, url, index) {
    return getFileType(job, url, index) === "image";
}



/**
 * Capture any document (PDF, Word, Excel, CSV, TXT) as images using Google Docs Viewer
 * This is the most reliable approach - render in Google Docs, screenshot, print as image
 */
async function captureDocumentAsImages(docUrl, fileType) {
    const images = [];
    
    // Create visible window for document rendering
    const docWindow = new BrowserWindow({
        show: true,
        x: 0,
        y: 0,
        width: 794,   // A4 width at 96 DPI
        height: 1123, // A4 height at 96 DPI
        frame: false,
        skipTaskbar: true,
        webPreferences: {
            sandbox: false,
            webSecurity: false,
        },
    });

    try {
        console.log(`Loading ${fileType} document:`, docUrl);
        
        const encodedUrl = encodeURIComponent(docUrl);
        
        // Use Google Docs Viewer for all document types (PDF, Word, Excel, CSV, TXT)
        // It renders them as images which we can capture
        const viewerUrl = `https://docs.google.com/viewer?url=${encodedUrl}&embedded=true`;
        
        const loadPromise = new Promise((resolve) => {
            docWindow.webContents.once("did-finish-load", resolve);
        });
        
        await docWindow.loadURL(viewerUrl);
        
        await Promise.race([
            loadPromise,
            new Promise((resolve) => setTimeout(resolve, 5000)), // Max 5s for initial load
        ]);
        
        // Wait for Google Docs Viewer to render the document
        console.log("Waiting for document to render...");
        await new Promise((r) => setTimeout(r, 8000)); // 8 seconds for full render
        
        // Capture the page as an image
        console.log("Capturing document as image...");
        const image = await docWindow.webContents.capturePage();
        const pngBuffer = image.toPNG();
        
        // Save to temp file
        const tempPath = path.join(app.getPath("temp"), `doc_${Date.now()}.png`);
        fs.writeFileSync(tempPath, pngBuffer);
        images.push(tempPath);
        
        console.log("Document captured successfully:", tempPath);
        
    } catch (error) {
        console.error("Failed to capture document:", error.message);
    } finally {
        docWindow.close();
    }

    return images;
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

async function printJob(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const isColor = String(color_mode || "color").toLowerCase() === "color";
    const tempFiles = []; // Track temp files for cleanup

    // Create print window for printing images
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

    /** Print a single image file */
    async function printImage(imagePath, printer, color) {
        const loadPromise = new Promise((resolve) => {
            printWindow.webContents.once("did-finish-load", resolve);
        });

        const html = buildImageHtml([imagePath]);
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

        const printOpts = {
            silent: true,
            printBackground: true,
            color: color,
            copies: 1,
            margins: { marginType: "none" },
            pageSize: "A4",
        };
        if (printer) printOpts.deviceName = printer;

        await doPrint(printWindow.webContents, printOpts);
    }

    try {
        const targetPrinter = await getTargetPrinter();

        for (let q = 0; q < qty; q++) {
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const fileType = getFileType(job, url, i);

                if (isDocument(job, url, i)) {
                    // 📄 DOCUMENT (PDF, Word, Excel, CSV, TXT): 
                    // Step 1: Capture as image using Google Docs Viewer
                    // Step 2: Print the image
                    console.log(`Converting ${fileType} to image:`, url);

                    const capturedImages = await captureDocumentAsImages(url, fileType);
                    tempFiles.push(...capturedImages);

                    if (capturedImages.length === 0) {
                        console.error("Failed to capture document, skipping:", url);
                        continue;
                    }

                    // Print each captured image
                    for (const imgPath of capturedImages) {
                        console.log("Printing captured image:", imgPath);
                        await printImage(`file://${imgPath}`, targetPrinter, isColor);
                        console.log("Printed successfully");
                    }

                } else {
                    // 🖼️ IMAGE: Print directly
                    console.log("Printing image:", url);
                    await printImage(url, targetPrinter, isColor);
                    console.log("Image printed successfully");
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
        // Cleanup temp files on error
        for (const tempFile of tempFiles) {
            try {
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            } catch (e) {}
        }
        throw error;
    }
}

app.whenReady().then(createWindow);
