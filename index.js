const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");

// Mitigate Windows "Access is denied" cache errors: use a userData path with write access
if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
    const userDataPath = path.join(appData, "HostegoPrint");
    try {
        if (!fs.existsSync(userDataPath)) fs.mkdirSync(userDataPath, { recursive: true });
        app.setPath("userData", userDataPath);
    } catch (e) {
        console.warn("Could not set userData path:", e.message);
    }
    app.commandLine.appendSwitch("disk-cache-size", "0");
}
// Reduce disk cache / GPU cache errors (all platforms)
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-features", "GpuDiskCache");

let mainWindow;

/** Get printer list. Uses getPrintersAsync (Electron 26+) or getPrinters (Electron 22 and older). */
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

/**
 * Convert PDF to high-quality PNG images for printing.
 * Solves black/blank page issues by rasterizing PDFs before print.
 */
async function pdfToImages(pdfUrl) {
    const loadingTask = pdfjsLib.getDocument(pdfUrl);
    const pdf = await loadingTask.promise;

    const images = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);

        // Scale 2 for high quality (300 DPI equivalent for A4)
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext("2d");

        await page.render({
            canvasContext: context,
            viewport,
        }).promise;

        const buffer = canvas.toBuffer("image/png");
        const filePath = path.join(
            app.getPath("temp"),
            `print_page_${Date.now()}_${pageNum}.png`
        );

        fs.writeFileSync(filePath, buffer);
        images.push(`file://${filePath}`);
    }

    return images;
}

function createWindow() {
    // Determine icon path based on platform
    let iconPath;
    if (process.platform === "darwin") {
        // macOS - prefer .icns, fallback to .png
        const icnsPath = path.join(__dirname, "assets/icon.icns");
        const pngPath = path.join(__dirname, "assets/icon.png");
        iconPath = require("fs").existsSync(icnsPath) ? icnsPath : pngPath;
    } else if (process.platform === "win32") {
        // Windows - use .ico
        iconPath = path.join(__dirname, "assets/favicon.ico");
    } else {
        // Linux - use .png
        iconPath = path.join(__dirname, "assets/icon.png");
    }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        icon: iconPath,
        title: "Hostego Print", // Set window title
        webPreferences: {
            preload: __dirname + "/preload.js",
        },
    });

    mainWindow.loadURL("https://hostego.in/printego-partner");

    // Set the dock icon on macOS
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
        await printImages(job);
        return { success: true, message: "Print job completed successfully" };
    } catch (err) {
        console.error("Print failed", err);
        return { success: false, error: err.message };
    }
});

/** True when the URL points to a PDF (by extension .pdf at end or before ?#). */
function isPdfUrl(url) {
    return /\.pdf($|[?#])/i.test(String(url || ""));
}

/** True if the item at index is a PDF. Uses job.file_types when provided (matches Printego Partner file_type), else isPdfUrl. */
function isPdf(job, url, index) {
    const ft = job.file_types && Array.isArray(job.file_types) ? String(job.file_types[index] || "").toLowerCase() : "";
    if (ft && (ft === "pdf" || ft === "application/pdf" || ft.includes("pdf"))) return true;
    if (ft && !ft.includes("pdf")) return false;
    return isPdfUrl(url);
}

/** Escape string for safe use inside an HTML attribute. */
function escapeHtmlAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Build HTML that embeds a PDF via <embed>. Works better in Electron than loadURL(pdfUrl) for display and print. */
function buildPdfHtml(url) {
    const esc = escapeHtmlAttr(url);
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{margin:0;padding:0;box-sizing:border-box;}
        html,body{width:100%;height:100%;overflow:hidden;}
        @page{size:A4;margin:0;}
        @media print{body{margin:0;padding:0;}}
        embed{display:block;width:100%;height:100%;border:0;}
    </style></head><body><embed src="${esc}" type="application/pdf" /></body></html>`;
}

/** Build HTML to display one or more image URLs (one per page). */
function buildImageHtml(urls) {
    const body = urls
        .map((u) => `<div class="page"><img src="${u}" /></div>`)
        .join("");
    return `<!DOCTYPE html><html><head><style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        @media print { body { margin: 0; padding: 0; } }
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; }
        .page { 
            width: 100%; 
            height: 100vh; 
            page-break-after: always; 
            page-break-inside: avoid;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .page:last-child { page-break-after: auto; }
        img { 
            max-width: 100%; 
            max-height: 100%; 
            width: auto;
            height: auto;
            object-fit: contain;
            display: block;
        }
    </style></head><body>${body}</body></html>`;
}

async function printImages(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const isColor = String(color_mode || "color").toLowerCase() === "color";
    const allImages = urls.every((u, i) => !isPdf(job, u, i));

    // Print window must be "shown" and have proper size for rendering. Off-screen (x: -10000) can cause
    // black/blank pages for PDFs due to GPU issues. Position at (0,0) with no frame, not in taskbar.
    // hardwareAcceleration: false uses CPU rendering to avoid GPU black-screen bugs.
    const printWindow = new BrowserWindow({
        show: true,
        x: 0,
        y: 0,
        width: 794,
        height: 1123,
        frame: false,
        skipTaskbar: true,
        alwaysOnTop: false,
        webPreferences: {
            sandbox: false,
            backgroundThrottling: false,
            offscreen: false,
            hardwareAcceleration: false,
        },
    });

    function resolveTargetDevice(contents) {
        return (async () => {
            const printers = await getPrintersList(contents);
            if (printers.length === 0) throw new Error("No printers found. Please connect a printer and try again.");
            if (!deviceName) {
                const def = printers.find((p) => p.isDefault) || printers[0];
                return def ? def.name : null;
            }
            const found = printers.some((p) => p.name === deviceName);
            if (!found) throw new Error(`Printer "${deviceName}" not found. Please select another or refresh.`);
            return deviceName;
        })();
    }

    function doPrint(contents, opts) {
        return new Promise((resolvePrint, rejectPrint) => {
            contents.print(opts, (success, failureReason) => {
                if (success) resolvePrint();
                else rejectPrint(new Error(failureReason || "Print failed"));
            });
        });
    }

    // --- All images: one HTML, one print with copies (optimized) ---
    if (allImages) {
        const html = buildImageHtml(urls);
        const readyPromise = new Promise((r) => {
            const done = () => r();
            printWindow.webContents.once("dom-ready", done);
            printWindow.webContents.once("did-finish-load", done);
        });
        await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

        return new Promise((resolve, reject) => {
            (async () => {
                try {
                    await Promise.race([
                        readyPromise,
                        new Promise((_, rej) => setTimeout(() => rej(new Error("Print preparation timed out. Please try again.")), 10000)),
                    ]);
                    const targetDevice = await resolveTargetDevice(printWindow.webContents);

                    const waitImages = printWindow.webContents.executeJavaScript(`
                        (function(){
                            return new Promise(function(resolve){
                                var imgs = document.images;
                                if (imgs.length === 0) return resolve();
                                var left = imgs.length;
                                function done(){ if (--left === 0) resolve(); }
                                for (var i = 0; i < imgs.length; i++) {
                                    if (imgs[i].complete) done();
                                    else { imgs[i].onload = done; imgs[i].onerror = done; }
                                }
                            });
                        })();
                    `);
                    await Promise.race([waitImages, new Promise((r) => setTimeout(r, 15000))]);
                    await new Promise((r) => setTimeout(r, 500));

                    const printOpts = {
                        silent: true,
                        printBackground: true,
                        color: isColor,
                        copies: qty,
                        margins: { marginType: "none" },
                        pageSize: "A4",
                    };
                    if (targetDevice) printOpts.deviceName = targetDevice;

                    await Promise.race([
                        doPrint(printWindow.webContents, printOpts),
                        new Promise((_, rej) => setTimeout(() => rej(new Error("Print timed out. Check that the printer is on and connected.")), 30000)),
                    ]);

                    printWindow.close();
                    resolve();
                } catch (error) {
                    printWindow.close();
                    reject(error);
                }
            })();
        });
    }

    // --- Mixed or all PDFs: load each URL, detect PDF vs image, print one-by-one; repeat `qty` times for copies ---
    let targetDevice = null;
    const tempFiles = []; // Track temp files for cleanup

    for (let q = 0; q < qty; q++) {
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];

            if (isPdf(job, url, i)) {
                // 🎯 PDF → Images → Print (no black pages!)
                const pdfImages = await pdfToImages(url);
                tempFiles.push(...pdfImages);

                for (const imgUrl of pdfImages) {
                    const readyPromise = new Promise((r) => {
                        const done = () => r();
                        printWindow.webContents.once("dom-ready", done);
                        printWindow.webContents.once("did-finish-load", done);
                    });

                    const html = buildImageHtml([imgUrl]);
                    await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
                    await Promise.race([
                        readyPromise,
                        new Promise((_, rej) => setTimeout(() => rej(new Error("Print preparation timed out. Please try again.")), 10000)),
                    ]);

                    if (targetDevice === null) {
                        try {
                            targetDevice = await resolveTargetDevice(printWindow.webContents);
                        } catch (e) {
                            printWindow.close();
                            throw e;
                        }
                    }

                    const waitImages = printWindow.webContents.executeJavaScript(`
                        (function(){
                            return new Promise(function(resolve){
                                var imgs = document.images;
                                if (imgs.length === 0) return resolve();
                                var left = imgs.length;
                                function done(){ if (--left === 0) resolve(); }
                                for (var i = 0; i < imgs.length; i++) {
                                    if (imgs[i].complete) done();
                                    else { imgs[i].onload = done; imgs[i].onerror = done; }
                                }
                            });
                        })();
                    `);
                    await Promise.race([waitImages, new Promise((r) => setTimeout(r, 15000))]);
                    await new Promise((r) => setTimeout(r, 500));

                    const printOpts = {
                        silent: true,
                        printBackground: true,
                        color: isColor,
                        copies: 1,
                        margins: { marginType: "none" },
                        pageSize: "A4",
                    };
                    if (targetDevice) printOpts.deviceName = targetDevice;

                    await Promise.race([
                        doPrint(printWindow.webContents, printOpts),
                        new Promise((_, rej) => setTimeout(() => rej(new Error("Print timed out. Check that the printer is on and connected.")), 30000)),
                    ]);
                }
            } else {
                // Regular image printing
                const readyPromise = new Promise((r) => {
                    const done = () => r();
                    printWindow.webContents.once("dom-ready", done);
                    printWindow.webContents.once("did-finish-load", done);
                });

                const html = buildImageHtml([url]);
                await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
                await Promise.race([
                    readyPromise,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Print preparation timed out. Please try again.")), 10000)),
                ]);

                if (targetDevice === null) {
                    try {
                        targetDevice = await resolveTargetDevice(printWindow.webContents);
                    } catch (e) {
                        printWindow.close();
                        throw e;
                    }
                }

                const waitImages = printWindow.webContents.executeJavaScript(`
                    (function(){
                        return new Promise(function(resolve){
                            var imgs = document.images;
                            if (imgs.length === 0) return resolve();
                            var left = imgs.length;
                            function done(){ if (--left === 0) resolve(); }
                            for (var i = 0; i < imgs.length; i++) {
                                if (imgs[i].complete) done();
                                else { imgs[i].onload = done; imgs[i].onerror = done; }
                            }
                        });
                    })();
                `);
                await Promise.race([waitImages, new Promise((r) => setTimeout(r, 15000))]);
                await new Promise((r) => setTimeout(r, 500));

                const printOpts = {
                    silent: true,
                    printBackground: true,
                    color: isColor,
                    copies: 1,
                    margins: { marginType: "none" },
                    pageSize: "A4",
                };
                if (targetDevice) printOpts.deviceName = targetDevice;

                await Promise.race([
                    doPrint(printWindow.webContents, printOpts),
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Print timed out. Check that the printer is on and connected.")), 30000)),
                ]);
            }
        }
    }

    printWindow.close();

    // Cleanup temp PDF images
    tempFiles.forEach((filePath) => {
        try {
            const localPath = filePath.replace("file://", "");
            if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
            }
        } catch (e) {
            console.warn("Cleanup failed for:", filePath, e.message);
        }
    });
}

app.whenReady().then(createWindow);
