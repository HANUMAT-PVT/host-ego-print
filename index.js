const { app, BrowserWindow, ipcMain, net } = require("electron");
const path = require("path");
const fs = require("fs");
const mammoth = require("mammoth");
const XLSX = require("xlsx");

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

/** Download file from URL to buffer */
async function downloadFile(url) {
    return new Promise((resolve, reject) => {
        const request = net.request(url);
        const chunks = [];
        
        request.on("response", (response) => {
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks)));
            response.on("error", reject);
        });
        
        request.on("error", reject);
        request.end();
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
        if (ft.includes("image") || ft.includes("png") || ft.includes("jpg") || ft.includes("jpeg") || ft.includes("gif") || ft.includes("webp")) return "image";
    }
    
    if (/\.pdf($|[?#])/i.test(urlStr)) return "pdf";
    if (/\.xlsx($|[?#])/i.test(urlStr)) return "excel";
    if (/\.xls($|[?#])/i.test(urlStr)) return "excel";
    if (/\.docx($|[?#])/i.test(urlStr)) return "word";
    if (/\.doc($|[?#])/i.test(urlStr)) return "word";
    if (/\.csv($|[?#])/i.test(urlStr)) return "csv";
    if (/\.txt($|[?#])/i.test(urlStr)) return "text";
    if (/\.(png|jpe?g|gif|webp|bmp|svg)($|[?#])/i.test(urlStr)) return "image";
    
    return "image";
}

/** Convert Word document to HTML */
async function wordToHtml(buffer) {
    const result = await mammoth.convertToHtml({ buffer });
    return result.value;
}

/** Convert Excel to HTML table */
function excelToHtml(buffer) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    let html = "";
    
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const sheetHtml = XLSX.utils.sheet_to_html(sheet, { header: "" });
        html += `<h2 style="margin: 20px 0 10px 0; font-family: Arial;">${sheetName}</h2>${sheetHtml}`;
    }
    
    return html;
}

/** Convert CSV to HTML table */
function csvToHtml(text) {
    const lines = text.trim().split("\n");
    let html = "<table border='1' cellpadding='8' cellspacing='0' style='border-collapse: collapse; width: 100%; font-family: Arial; font-size: 12px;'>";
    
    for (let i = 0; i < lines.length; i++) {
        const cells = lines[i].split(",");
        const tag = i === 0 ? "th" : "td";
        html += "<tr>";
        for (const cell of cells) {
            html += `<${tag} style="border: 1px solid #333; padding: 8px;">${cell.trim()}</${tag}>`;
        }
        html += "</tr>";
    }
    
    html += "</table>";
    return html;
}

/** Build printable HTML document */
function buildPrintHtml(content, title = "Document") {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 15mm; }
        html, body { 
            width: 100%; 
            min-height: 100%;
            background: white;
            font-family: Arial, sans-serif;
            font-size: 12px;
            line-height: 1.5;
            padding: 20px;
        }
        table { border-collapse: collapse; width: 100%; margin: 10px 0; }
        th, td { border: 1px solid #333; padding: 8px; text-align: left; }
        th { background: #f0f0f0; font-weight: bold; }
        img { max-width: 100%; height: auto; }
        pre { white-space: pre-wrap; word-wrap: break-word; font-family: 'Courier New', monospace; }
    </style>
</head>
<body>
    ${content}
</body>
</html>`;
}

/** Build HTML for image */
function buildImageHtml(url) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: white; }
        .container { width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; }
        img { max-width: 100%; max-height: 100%; object-fit: contain; }
    </style>
</head>
<body>
    <div class="container">
        <img src="${url}" onload="window.loaded=true" onerror="window.loaded=true" />
    </div>
</body>
</html>`;
}

/** Build HTML for PDF using PDF.js */
function buildPdfHtml(pdfUrl) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: A4; margin: 0; }
        @media print { .page { page-break-after: always; } .page:last-child { page-break-after: auto; } }
        html, body { background: white; }
        .page { width: 210mm; min-height: 297mm; display: flex; justify-content: center; align-items: center; background: white; }
        canvas { max-width: 100%; max-height: 297mm; }
        #loading { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); font-family: Arial; font-size: 18px; }
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
                    
                    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                    
                    const pageDiv = document.createElement('div');
                    pageDiv.className = 'page';
                    pageDiv.appendChild(canvas);
                    container.appendChild(pageDiv);
                }
                
                window.pdfRendered = true;
                console.log('PDF rendered:', pdf.numPages, 'pages');
            } catch (error) {
                document.getElementById('loading').textContent = 'Error: ' + error.message;
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

    // Create print window
    const printWindow = new BrowserWindow({
        show: true,
        x: 100,
        y: 100,
        width: 794,
        height: 1123,
        title: "Printing...",
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

    try {
        const targetPrinter = await getTargetPrinter();
        console.log("Using printer:", targetPrinter);

        for (let q = 0; q < qty; q++) {
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const fileType = getFileType(job, url, i);
                
                console.log(`[${i + 1}/${urls.length}] Processing ${fileType}:`, url);

                let html = "";

                // Convert document to HTML based on type
                if (fileType === "pdf") {
                    // PDF: Use PDF.js to render to canvas
                    html = buildPdfHtml(url);
                    
                } else if (fileType === "word") {
                    // Word: Download and convert with mammoth
                    console.log("Downloading Word document...");
                    const buffer = await downloadFile(url);
                    console.log("Converting Word to HTML...");
                    const content = await wordToHtml(buffer);
                    html = buildPrintHtml(content, "Word Document");
                    
                } else if (fileType === "excel") {
                    // Excel: Download and convert with xlsx
                    console.log("Downloading Excel file...");
                    const buffer = await downloadFile(url);
                    console.log("Converting Excel to HTML...");
                    const content = excelToHtml(buffer);
                    html = buildPrintHtml(content, "Excel Spreadsheet");
                    
                } else if (fileType === "csv") {
                    // CSV: Download and convert to table
                    console.log("Downloading CSV file...");
                    const buffer = await downloadFile(url);
                    console.log("Converting CSV to HTML...");
                    const content = csvToHtml(buffer.toString("utf-8"));
                    html = buildPrintHtml(content, "CSV File");
                    
                } else if (fileType === "text") {
                    // Text: Download and display as preformatted
                    console.log("Downloading text file...");
                    const buffer = await downloadFile(url);
                    const escaped = buffer.toString("utf-8")
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;");
                    html = buildPrintHtml(`<pre>${escaped}</pre>`, "Text File");
                    
                } else {
                    // Image: Display directly
                    html = buildImageHtml(url);
                }

                // Load the HTML
                const loadPromise = new Promise((resolve) => {
                    printWindow.webContents.once("did-finish-load", resolve);
                });

                await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));

                await Promise.race([
                    loadPromise,
                    new Promise((resolve) => setTimeout(resolve, 10000)),
                ]);

                // Wait for content to render
                if (fileType === "pdf") {
                    // Wait for PDF.js to finish
                    console.log("Waiting for PDF.js to render...");
                    try {
                        await printWindow.webContents.executeJavaScript(`
                            new Promise((resolve, reject) => {
                                let checks = 0;
                                const check = () => {
                                    if (window.pdfRendered) resolve();
                                    else if (window.pdfError) reject(new Error(window.pdfError));
                                    else if (++checks > 100) reject(new Error('PDF timeout'));
                                    else setTimeout(check, 200);
                                };
                                check();
                            });
                        `);
                    } catch (e) {
                        console.log("PDF render issue:", e.message);
                    }
                    await new Promise((r) => setTimeout(r, 1000));
                } else if (fileType === "image") {
                    // Wait for image
                    try {
                        await printWindow.webContents.executeJavaScript(`
                            new Promise((resolve) => {
                                if (window.loaded) return resolve();
                                const img = document.querySelector('img');
                                if (!img || img.complete) return resolve();
                                img.onload = img.onerror = resolve;
                                setTimeout(resolve, 5000);
                            });
                        `);
                    } catch (e) {}
                    await new Promise((r) => setTimeout(r, 500));
                } else {
                    // Other documents - just wait a bit
                    await new Promise((r) => setTimeout(r, 1000));
                }

                // Print
                console.log("Printing...");
                const printOpts = {
                    silent: true,
                    printBackground: true,
                    color: isColor,
                    copies: 1,
                    margins: { marginType: fileType === "image" || fileType === "pdf" ? "none" : "default" },
                    pageSize: "A4",
                };
                if (targetPrinter) printOpts.deviceName = targetPrinter;

                await doPrint(printWindow.webContents, printOpts);
                console.log("Printed successfully!");
            }
        }

        printWindow.close();
        console.log("All jobs completed!");

    } catch (error) {
        console.error("Print error:", error.message);
        printWindow.close();
        throw error;
    }
}

app.whenReady().then(createWindow);
