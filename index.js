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

/** Get printer list. Uses getPrintersAsync (Electron 26+) or getPrinters (older). */
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

async function printImages(job) {
    const { images_urls, quantity, color_mode } = job;
    const deviceName = job.deviceName || job.printerName;

    if (!images_urls || !Array.isArray(images_urls) || images_urls.length === 0) {
        throw new Error("images_urls is required and must be a non-empty array.");
    }

    const printWindow = new BrowserWindow({
        show: false, // VERY IMPORTANT
        webPreferences: {
            sandbox: false,
        },
    });

    const imagesHTML = images_urls
        .map(
            (url) => `
        <div class="page">
          <img src="${url}" />
        </div>
      `
        )
        .join("");

    const html = `
    <html>
      <head>
        <style>
          @page {
            size: A4;
            margin: 0;
          }
          body {
            margin: 0;
          }
          .page {
            page-break-after: always;
          }
          img {
            width: 100%;
            height: 100%;
            object-fit: contain;
          }
        </style>
      </head>
      <body>
        ${imagesHTML}
      </body>
    </html>
  `;

    await printWindow.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(html)
    );

    return new Promise((resolve, reject) => {
        printWindow.webContents.on("did-finish-load", async () => {
            try {
                const printers = await getPrintersList(printWindow.webContents);
                if (printers.length === 0) {
                    printWindow.close();
                    throw new Error("No printers found. Please connect a printer and try again.");
                }
                if (deviceName) {
                    const found = printers.some((p) => p.name === deviceName);
                    if (!found) {
                        printWindow.close();
                        throw new Error(`Printer "${deviceName}" not found. Please select another or refresh.`);
                    }
                }

                // Wait for images to load before printing
                await printWindow.webContents.executeJavaScript(`
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

                const printOpts = {
                    silent: true,
                    printBackground: true,
                    color: color_mode === "color",
                    copies: Math.max(1, parseInt(quantity, 10) || 1),
                };
                if (deviceName) printOpts.deviceName = deviceName;

                await new Promise((resolvePrint, rejectPrint) => {
                    printWindow.webContents.print(printOpts, (success, failureReason) => {
                        if (success) resolvePrint();
                        else rejectPrint(new Error(failureReason || "Print failed"));
                    });
                });

                printWindow.close();
                resolve();
            } catch (error) {
                printWindow.close();
                reject(error);
            }
        });
    });
}

app.whenReady().then(createWindow);
