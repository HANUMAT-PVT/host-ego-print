const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");

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

    mainWindow.loadURL("https://hostego.in/admin/print");

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

/** Build HTML to display one or more image URLs (one per page). */
function buildImageHtml(urls) {
    const body = urls
        .map((u) => `<div class="page"><img src="${u}" /></div>`)
        .join("");
    return `<!DOCTYPE html><html><head><style>@page{size:A4;margin:0;}body{margin:0;}.page{page-break-after:always;}img{width:100%;height:100%;object-fit:contain;}</style></head><body>${body}</body></html>`;
}

async function printImages(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const allImages = urls.every((u) => !isPdfUrl(u));

    // Must have size and be "shown" (can be off-screen) so the print engine renders. Purely hidden
    // windows can cause print to hang or the callback to never fire on some OS/drivers.
    const printWindow = new BrowserWindow({
        show: true,
        x: -10000,
        y: -10000,
        width: 794,
        height: 1123,
        webPreferences: {
            sandbox: false,
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
                        color: color_mode === "color",
                        copies: qty,
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
    for (let q = 0; q < qty; q++) {
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            const readyPromise = new Promise((r) => {
                const done = () => r();
                printWindow.webContents.once("dom-ready", done);
                printWindow.webContents.once("did-finish-load", done);
            });

            if (isPdfUrl(url)) {
                await printWindow.loadURL(url);
                await Promise.race([
                    readyPromise,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("PDF load timed out. Please try again.")), 15000)),
                ]);
            } else {
                const html = buildImageHtml([url]);
                await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
                await Promise.race([
                    readyPromise,
                    new Promise((_, rej) => setTimeout(() => rej(new Error("Print preparation timed out. Please try again.")), 10000)),
                ]);
            }

            if (targetDevice === null) {
                try {
                    targetDevice = await resolveTargetDevice(printWindow.webContents);
                } catch (e) {
                    printWindow.close();
                    throw e;
                }
            }

            if (isPdfUrl(url)) {
                await new Promise((r) => setTimeout(r, 800));
            } else {
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
            }

            const printOpts = {
                silent: true,
                printBackground: true,
                color: color_mode === "color",
                copies: 1,
            };
            if (targetDevice) printOpts.deviceName = targetDevice;

            await Promise.race([
                doPrint(printWindow.webContents, printOpts),
                new Promise((_, rej) => setTimeout(() => rej(new Error("Print timed out. Check that the printer is on and connected.")), 30000)),
            ]);
        }
    }
    printWindow.close();
}

app.whenReady().then(createWindow);
