# Windows Build Guide

## IMPORTANT: Build on Windows, Not Mac

**Building Windows apps on Mac causes ffmpeg.dll issues.** 

The solution is simple: **Build directly on Windows.**

---

## Quick Build on Windows

### Option 1: Use the batch file

```cmd
build-windows.bat
```

### Option 2: Manual commands

```cmd
npm install
npm run build
```

The installer will be at: `dist\Hostego Print Setup 1.0.0.exe`

---

## "ffmpeg.dll was not found" Error

If you see this error when running the built app on Windows, try these solutions:

### Solution 1: Use the Correct Build Folder

Make sure you're running the app from the **correct location**:

```
dist/win-unpacked/Hostego Print.exe
```

**NOT** from any other folder or shortcut.

### Solution 2: Check ffmpeg.dll is Present

1. Navigate to `dist/win-unpacked/`
2. Verify `ffmpeg.dll` exists in the same folder as `Hostego Print.exe`
3. File size should be around **1.7 MB**

If missing, rebuild:
```bash
npm run clean
npm run build:win
```

### Solution 3: Install Visual C++ Redistributables

Electron 22 requires **Visual C++ Redistributables**. Download and install:

**For x64 (64-bit Windows):**
- [VC++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)

**For ia32 (32-bit Windows):**
- [VC++ 2015-2022 Redistributable (x86)](https://aka.ms/vs/17/release/vc_redist.x86.exe)

### Solution 4: Disable Antivirus Temporarily

Some antivirus software blocks or quarantines `ffmpeg.dll`:

1. Temporarily disable antivirus
2. Run the app again
3. If it works, add the app folder to antivirus exclusions

### Solution 5: Run from Command Line (Debug)

Open Command Prompt in `dist/win-unpacked/` and run:

```cmd
"Hostego Print.exe"
```

Check for any additional error messages that might give more clues.

### Solution 6: Check Windows Version

Electron 22 supports:
- ✅ Windows 7 SP1
- ✅ Windows 8 / 8.1
- ✅ Windows 10
- ✅ Windows 11

If you're on an older version, it may not work.

### Solution 7: Rebuild with Clean Install

```bash
# Remove everything
npm run clean
rm -rf node_modules
rm package-lock.json

# Fresh install
npm install

# Build
npm run build:win
```

### Solution 8: Try the Unpacked App First

Before creating an installer, test the unpacked app:

1. Copy the entire `dist/win-unpacked/` folder to the Windows machine
2. Run `Hostego Print.exe` directly from that folder
3. If it works, the issue is with the installer
4. If it doesn't work, the issue is with the app itself or missing dependencies

## Building on Windows vs Mac

### On Mac (Cross-compile to Windows):
```bash
# Install Wine and NSIS first
brew install wine makensis

# Build
npm run build:win
```

### On Windows (Native build):
```bash
# Just build
npm run build
```

## Common Issues

### Issue: "NSIS installer not created"
- **On Mac:** Install Wine and makensis: `brew install wine makensis`
- **On Windows:** Should work by default

### Issue: "Access is denied" during build
- Close any running instances of the app
- Run `npm run clean` before building
- See the main README for more details

### Issue: Different error on older Windows (7/8)
- Make sure Visual C++ Redistributables are installed
- Try running as Administrator
- Check Windows Update is current

## File Structure

After a successful build, you should have:

```
dist/
  win-unpacked/
    Hostego Print.exe          ← Main executable
    ffmpeg.dll                 ← Required (1.7 MB)
    d3dcompiler_47.dll         ← Required
    libEGL.dll                 ← Required
    libGLESv2.dll              ← Required
    vk_swiftshader.dll         ← Required
    vulkan-1.dll               ← Required
    resources/
      app.asar                 ← Your app code
    locales/                   ← Language files
    ...
```

All DLL files must be present for the app to run.

## Still Not Working?

1. Check the exact error message - is it specifically "ffmpeg.dll" or another DLL?
2. Try running on a different Windows machine to rule out system-specific issues
3. Check if the issue happens with both x64 and ia32 builds
4. Open an issue with:
   - Exact error message
   - Windows version
   - Build command used
   - Output of `dir dist\win-unpacked\*.dll` on Windows
