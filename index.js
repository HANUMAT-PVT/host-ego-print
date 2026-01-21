const { app, BrowserWindow, ipcMain, net } = require("electron");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");

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

/** Download file from URL to local path */
async function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const request = net.request(url);
        const chunks = [];
        
        request.on("response", (response) => {
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
                try {
                    fs.writeFileSync(destPath, Buffer.concat(chunks));
                    resolve(destPath);
                } catch (e) {
                    reject(e);
                }
            });
            response.on("error", reject);
        });
        
        request.on("error", reject);
        request.end();
    });
}

/** Get LibreOffice command based on platform */
function getLibreOfficeCommand() {
    if (process.platform === "win32") {
        // Common Windows paths for LibreOffice
        const paths = [
            "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
            "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
            "soffice" // If added to PATH
        ];
        for (const p of paths) {
            if (p === "soffice" || fs.existsSync(p)) {
                return `"${p}"`;
            }
        }
        return `"${paths[0]}"`; // Default
    } else if (process.platform === "darwin") {
        return "/Applications/LibreOffice.app/Contents/MacOS/soffice";
    } else {
        return "libreoffice";
    }
}

/** Convert document (Word/Excel) to PDF using LibreOffice */
async function convertToPdf(inputPath, outputDir) {
    return new Promise((resolve, reject) => {
        const soffice = getLibreOfficeCommand();
        const cmd = `${soffice} --headless --convert-to pdf "${inputPath}" --outdir "${outputDir}"`;
        
        console.log("Running LibreOffice conversion:", cmd);
        
        exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
            if (error) {
                console.error("LibreOffice error:", error.message);
                console.error("stderr:", stderr);
                reject(new Error(`LibreOffice conversion failed: ${error.message}`));
                return;
            }
            
            // Find the output PDF
            const inputName = path.basename(inputPath, path.extname(inputPath));
            const pdfPath = path.join(outputDir, inputName + ".pdf");
            
            if (fs.existsSync(pdfPath)) {
                console.log("PDF created:", pdfPath);
                resolve(pdfPath);
            } else {
                reject(new Error("PDF output not found after conversion"));
            }
        });
    });
}

/** Check file type from URL */
function getFileType(job, url, index) {
    const urlStr = String(url || "").toLowerCase();
    const ft = job.file_types && Array.isArray(job.file_types) ? String(job.file_types[index] || "").toLowerCase() : "";
    
    if (ft) {
        if (ft === "pdf" || ft === "application/pdf" || ft.includes("pdf")) return "pdf";
        if (ft.includes("excel") || ft.includes("xlsx") || ft.includes("xls") || ft.includes("spreadsheet")) return "excel";
        if (ft.includes("word") || ft.includes("docx") || ft.includes("doc") || ft.includes("document")) return "word";
        if (ft.includes("csv")) return "csv";
        if (ft.includes("text") || ft.includes("txt")) return "text";
        if (ft.includes("image")) return "image";
    }
    
    if (/\.pdf($|[?#])/i.test(urlStr)) return "pdf";
    if (/\.(xlsx?|xls)($|[?#])/i.test(urlStr)) return "excel";
    if (/\.(docx?|doc)($|[?#])/i.test(urlStr)) return "word";
    if (/\.csv($|[?#])/i.test(urlStr)) return "csv";
    if (/\.txt($|[?#])/i.test(urlStr)) return "text";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)($|[?#])/i.test(urlStr)) return "image";
    
    return "image";
}

/** Check if file needs LibreOffice conversion */
function needsConversion(fileType) {
    return fileType === "word" || fileType === "excel" || fileType === "csv" || fileType === "text";
}

/** Get file extension for download */
function getExtension(fileType, url) {
    const urlLower = url.toLowerCase();
    if (fileType === "word") {
        return urlLower.includes(".doc") && !urlLower.includes(".docx") ? ".doc" : ".docx";
    }
    if (fileType === "excel") {
        return urlLower.includes(".xls") && !urlLower.includes(".xlsx") ? ".xls" : ".xlsx";
    }
    if (fileType === "csv") return ".csv";
    if (fileType === "text") return ".txt";
    return ".tmp";
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

/** Build HTML for PDF using PDF.js */
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
        canvas { max-width: 100%; max-height: 297mm; }
        #loading { 
            position: fixed; top: 50%; left: 50%; 
            transform: translate(-50%, -50%);
            font-family: Arial; font-size: 18px;
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
                    const scale = 2;
                    const viewport = page.getViewport({ scale });
                    
                    const canvas = document.createElement('canvas');
                    canvas.width = viewport.width;
                    canvas.height = viewport.height;
                    
                    await page.render({
                        canvasContext: canvas.getContext('2d'),
                        viewport: viewport
                    }).promise;
                    
                    const pageDiv = document.createElement('div');
                    pageDiv.className = 'page';
                    pageDiv.appendChild(canvas);
                    container.appendChild(pageDiv);
                }
                
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

    const urls = images_urls;
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const isColor = String(color_mode || "color").toLowerCase() === "color";
    const tempFiles = []; // Track temp files for cleanup

    // Create print window
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
            webSecurity: false,
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

    /** Print a PDF (either direct URL or file:// path) */
    async function printPdf(pdfUrl) {
        const loadPromise = new Promise((resolve) => {
            printWindow.webContents.once("did-finish-load", resolve);
        });

        const html = buildPdfRenderHtml(pdfUrl);
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
                    if (window.pdfRendered) resolve();
                    else if (window.pdfError) reject(new Error(window.pdfError));
                    else if (checks > 150) reject(new Error('PDF render timeout'));
                    else setTimeout(check, 200);
                };
                check();
            });
        `);

        await new Promise((r) => setTimeout(r, 1000));

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

    /** Print an image */
    async function printImage(imageUrl) {
        const loadPromise = new Promise((resolve) => {
            printWindow.webContents.once("did-finish-load", resolve);
        });

        const html = buildImageHtml([imageUrl]);
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

    let targetPrinter;

    try {
        targetPrinter = await getTargetPrinter();
        console.log("Using printer:", targetPrinter);

        const tempDir = app.getPath("temp");

        for (let q = 0; q < qty; q++) {
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const fileType = getFileType(job, url, i);
                
                console.log(`[${i + 1}/${urls.length}] (copy ${q + 1}) Type: ${fileType}`);

                if (needsConversion(fileType)) {
                    // Word/Excel/CSV/TXT → Convert to PDF with LibreOffice → Print PDF
                    console.log("Converting with LibreOffice:", url);
                    
                    // Download the file
                    const ext = getExtension(fileType, url);
                    const inputPath = path.join(tempDir, `input_${Date.now()}${ext}`);
                    
                    console.log("Downloading to:", inputPath);
                    await downloadFile(url, inputPath);
                    tempFiles.push(inputPath);
                    
                    // Convert to PDF
                    console.log("Converting to PDF...");
                    const pdfPath = await convertToPdf(inputPath, tempDir);
                    tempFiles.push(pdfPath);
                    
                    // Print the PDF
                    console.log("Printing converted PDF:", pdfPath);
                    await printPdf(`file://${pdfPath}`);
                    console.log("Printed successfully!");
                    
                } else if (fileType === "pdf") {
                    // PDF → Print directly with PDF.js
                    console.log("Printing PDF:", url);
                    await printPdf(url);
                    console.log("Printed successfully!");
                    
                } else {
                    // Image → Print directly
                    console.log("Printing image:", url);
                    await printImage(url);
                    console.log("Printed successfully!");
                }
            }
        }

        printWindow.close();
        console.log("All jobs completed!");

    } catch (error) {
        console.error("Print error:", error.message);
        printWindow.close();
        throw error;
    } finally {
        // Cleanup temp files
        for (const f of tempFiles) {
            try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
            } catch (e) {}
        }
    }
}

app.whenReady().then(createWindow);
