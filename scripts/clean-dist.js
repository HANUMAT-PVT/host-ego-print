#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const distPath = path.join(process.cwd(), "dist");

const HELP = `
The "dist" folder could not be cleaned (Access is denied). On Windows this is often caused by:

  1. Hostego Print or another Electron app is still running
     → Close it from Task Manager (electron.exe, Hostego Print, or your app name).

  2. Antivirus scanning or locking .dll files
     → Add an exclusion for this project folder, or disable it temporarily.

  3. Another program (e.g. Cursor, VS Code, Explorer) has files open
     → Close file previews on dist, or exclude the "dist" folder from watchers.

  4. Path or permissions
     → Move the project to a simple path (e.g. C:\\projects\\hostego-print) and avoid "New folder", OneDrive, or network drives.
     → Try running this terminal as Administrator.

Then run:  npm run clean
And retry: npm run build
`;

if (!fs.existsSync(distPath)) {
    process.exit(0);
}

try {
    fs.rmSync(distPath, { recursive: true, force: true, maxRetries: 2 });
} catch (err) {
    const code = err && err.code;
    if (code === "EACCES" || code === "EPERM" || code === "EBUSY" || (err && err.message && /Access is denied/i.test(err.message))) {
        console.error("\n\x1b[31m[build] Clean failed: " + (err.message || code) + "\x1b[0m");
        console.error(HELP);
        process.exit(1);
    }
    throw err;
}
