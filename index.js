const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

let mainWindow;

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

ipcMain.on("PRINT_JOB", async (event, job) => {
    try {
        await printImages(job);
        event.reply("PRINT_JOB_RESPONSE", { success: true, message: "Print job completed successfully" });
    } catch (err) {
        console.error("Print failed", err);
        event.reply("PRINT_JOB_RESPONSE", { success: false, error: err.message });
    }
});

async function printImages(job) {
    const { images_urls, quantity, color_mode } = job;

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
                // Check if any printers are available
                const printers = await printWindow.webContents.getPrinters();

                if (printers.length === 0) {
                    printWindow.close();
                    throw new Error("No printers found. Please connect a printer and try again.");
                }

                for (let i = 0; i < quantity; i++) {
                    await new Promise((resolve, reject) => {
                        printWindow.webContents.print(
                            {
                                silent: true,
                                printBackground: true,
                                color: color_mode === "color",
                            },
                            (success, failureReason) => {
                                if (success) {
                                    resolve();
                                } else {
                                    reject(new Error(failureReason || "Print failed"));
                                }
                            }
                        );
                    });
                }

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
