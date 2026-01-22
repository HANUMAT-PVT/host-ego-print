# Document Printing Guide

## ✅ What's New

Your Hostego Print Desktop app now supports printing **Word and Excel documents**!

### Supported File Types:
- 📝 **Documents**: `.doc`, `.docx`
- 📊 **Spreadsheets**: `.xls`, `.xlsx`  
- 📄 **PDFs**: `.pdf`
- 🖼️ **Images**: `.jpg`, `.png`, `.gif`, `.webp`
- 📑 **OpenDocument**: `.odt`, `.ods`, `.odp` (if LibreOffice is installed)

---

## 🛠️ Requirements

### LibreOffice Installation (Required for Documents)

**Windows:**
1. Download from: https://www.libreoffice.org/download/
2. Install to default location: `C:\Program Files\LibreOffice\`
3. Restart Hostego Print Desktop

**macOS:**
1. Download from: https://www.libreoffice.org/download/
2. Install to `/Applications/LibreOffice.app`
3. Restart Hostego Print Desktop

---

## 🧪 Testing

### Option 1: Use the Built-in Test Page

1. Launch Hostego Print Desktop
2. Go to **File → Open Test Page**
3. Click **"Check Capabilities"** to verify LibreOffice is detected
4. Use the test buttons to print sample documents

### Option 2: Test from Developer Console

1. Open the app
2. Press **Cmd+Shift+I** (Mac) or **Ctrl+Shift+I** (Windows)
3. In the console, run:

```javascript
// Check capabilities
await window.hostego.getCapabilities()

// Test document print
await window.hostego.print({
    images_urls: ["https://example.com/document.docx"],
    file_types: ["docx"],
    quantity: 1,
    color_mode: "color"
})
```

---

## 🔍 Troubleshooting

### "No printable files" error

This error comes from the **web application**, not the desktop app. The issue is:

1. The web app (hostego.in) is checking file types before sending to desktop
2. The web app may not yet support documents

**Solutions:**

**A) Update the Web Application:**
The web frontend needs to:
- Check `window.hostego.getCapabilities()` 
- Allow documents if `caps.supportsDocuments === true`

**B) Test Directly (Bypass Web App):**
Use the test page: **File → Open Test Page**

**C) Manual API Override (Temporary):**
Open DevTools and run:
```javascript
// This tells the web app we support documents
window.hostegoCapabilities = {
    supportsDocuments: true,
    supportedExtensions: ["pdf", "doc", "docx", "xls", "xlsx"]
};
```

---

## 📊 How It Works

```
Document URL (.docx, .xlsx) 
    ↓
Download to temp folder
    ↓
Convert to PDF using LibreOffice
    ↓
Render PDF with PDF.js
    ↓
Print
    ↓
Clean up temp files
```

---

## 🐛 Debugging

### Enable Console Logging

The app now logs everything! Check the console for:

```
=== PRINT JOB START ===
Job data: {...}
URL 0: https://example.com/doc.docx -> isDocument: true
Has documents: true
LibreOffice installed: true
🛠 Document detected, converting to PDF
Downloading document to: /tmp/...
Converting to PDF with LibreOffice...
Converted to PDF: /tmp/.../document.pdf
Rendering PDF with PDF.js
```

### Check LibreOffice Status

Go to **Help → Check LibreOffice** in the menu

### View Web App Communication

Open DevTools and check for:
- `🖨️ Hostego Desktop Print Client Loaded`
- `📋 Desktop Capabilities: {...}`
- `✅ Document printing enabled`

---

## 📝 API Reference

### `window.hostego.getCapabilities()`

Returns:
```javascript
{
    version: "1.0.0",
    supportsImages: true,
    supportsPDF: true,
    supportsDocuments: true,  // ← If LibreOffice is installed
    libreOfficeInstalled: true,
    supportedExtensions: ["jpg", "png", "pdf", "doc", "docx", "xls", "xlsx", ...]
}
```

### `window.hostego.print(options)`

```javascript
{
    images_urls: ["url1", "url2"],      // Required
    file_types: ["docx", "pdf"],        // Optional but recommended
    quantity: 1,                        // Default: 1
    color_mode: "color",                // "color" or "black"
    deviceName: "Printer Name"          // Optional
}
```

---

## 🚀 Next Steps

1. **Install LibreOffice** if you haven't already
2. **Test** using the built-in test page
3. **Update the web application** to check capabilities
4. **Deploy** the new desktop app

---

## ⚠️ Known Issues

- The web app (hostego.in) may still reject documents on the frontend
- This is a **web app issue**, not a desktop app issue
- Use the test page to verify desktop app works correctly
- Contact web app developers to add `window.hostego.getCapabilities()` support

---

## 📞 Support

If documents still don't print:

1. Check LibreOffice is installed: **Help → Check LibreOffice**
2. Try the test page: **File → Open Test Page**
3. Check console logs: **Cmd/Ctrl + Shift + I**
4. Verify the document URL is accessible
5. Contact support with console logs
