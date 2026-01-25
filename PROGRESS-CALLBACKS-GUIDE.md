# Print Progress Callbacks Guide

## ✅ Implementation Complete!

The Electron app now supports **real-time print progress callbacks** so your frontend can track which file is currently being printed.

---

## 📋 How It Works

### Progress Event Structure

Each progress event contains:
```typescript
{
  fileIndex: number,      // 0-based index of current file (0, 1, 2, ...)
  totalFiles: number,   // Total number of files in the print job
  status: string,       // Current status (see below)
  message: string,      // Human-readable status message
  url: string          // URL of the file being processed
}
```

### Status Values

- `'rendering'` - Rendering PDF/image for printing
- `'printing'` - Sending to printer
- `'completed'` - File printed successfully
- `'error'` - Error occurred

---

## 🚀 Frontend Usage

### Basic Example

```javascript
const startPrint = async (data) => {
  const printFiles = data?.printego_order?.print_files;
  const urlsToPrint = printFiles.map((f) => f.file_url);
  const fileTypes = printFiles.map((f) => f.file_type);

  setPrinting(true);
  setCurrentPrintingFileIndex(0);

  try {
    const res = await window.hostego.print({
      images_urls: urlsToPrint,
      file_types: fileTypes,
      quantity: order?.quantity ?? 1,
      color_mode: order?.color_mode ?? 'color',
      deviceName: selectedPrinter || undefined,
      
      // ✨ Add progress callback
      onProgress: (progress) => {
        console.log('Print progress:', progress);
        
        // Update UI based on progress
        if (progress.status === 'printing') {
          setCurrentPrintingFileIndex(progress.fileIndex);
        }
        
        if (progress.status === 'completed') {
          // File completed, move to next
          if (progress.fileIndex < progress.totalFiles - 1) {
            setCurrentPrintingFileIndex(progress.fileIndex + 1);
          }
        }
        
        if (progress.status === 'error') {
          setPrintStatus({ 
            type: 'error', 
            message: `Error printing file ${progress.fileIndex + 1}: ${progress.message}` 
          });
        }
      }
    });

    if (res?.success) {
      setPrintStatus({ 
        type: 'success', 
        message: `Print job completed! ${printFiles.length} file(s) sent to printer.`
      });
      setCurrentPrintingFileIndex(null);
    }
  } catch (e) {
    setPrintStatus({ type: 'error', message: e?.message || 'Print request failed.' });
    setCurrentPrintingFileIndex(null);
  } finally {
    setPrinting(false);
  }
};
```

---

## 🎨 Enhanced Frontend Integration

### Update Your React Component

```javascript
const startPrint = async (data) => {
  if (!window.hostego) {
    setPrintStatus({ type: 'error', message: 'Please use Hostego Print Desktop App to print' });
    return;
  }

  const printFiles = data?.printego_order?.print_files;
  if (!printFiles?.length) {
    setPrintStatus({ type: 'error', message: 'No files to print.' });
    return;
  }

  const order = data?.printego_order;
  const urlsToPrint = printFiles.map((f) => f.file_url);
  const fileTypes = printFiles.map((f) => f.file_type);

  setPrinting(true);
  setPrintStatus(null);
  setCurrentPrintingFileIndex(0);

  try {
    setPrintStatus({ 
      type: 'info', 
      message: `Preparing to print ${printFiles.length} file(s)...`
    });

    const res = await window.hostego.print({
      images_urls: urlsToPrint,
      file_types: fileTypes,
      quantity: order?.quantity ?? 1,
      color_mode: order?.color_mode ?? 'color',
      deviceName: selectedPrinter || undefined,
      
      // Progress callback
      onProgress: (progress) => {
        // Update current file index
        if (progress.fileIndex >= 0) {
          setCurrentPrintingFileIndex(progress.fileIndex);
        }

        // Update status message based on progress
        switch (progress.status) {
          case 'downloading':
            setPrintStatus({ 
              type: 'info', 
              message: `Downloading file ${progress.fileIndex + 1} of ${progress.totalFiles}...` 
            });
            break;
            
          case 'converting':
            setPrintStatus({ 
              type: 'info', 
              message: `Converting file ${progress.fileIndex + 1} of ${progress.totalFiles} to PDF...` 
            });
            break;
            
          case 'rendering':
            setPrintStatus({ 
              type: 'info', 
              message: `Rendering file ${progress.fileIndex + 1} of ${progress.totalFiles}...` 
            });
            break;
            
          case 'printing':
            setPrintStatus({ 
              type: 'info', 
              message: `Printing file ${progress.fileIndex + 1} of ${progress.totalFiles}...` 
            });
            break;
            
          case 'completed':
            // File completed - will move to next automatically
            break;
            
          case 'error':
            setPrintStatus({ 
              type: 'error', 
              message: `Error: ${progress.message}` 
            });
            break;
        }
      }
    });

    if (res?.success) {
      setPrintStatus({ 
        type: 'success', 
        message: `Print job completed! ${printFiles.length} file(s) sent to printer.`
      });
      setCurrentPrintingFileIndex(null);
    } else {
      setPrintStatus({ type: 'error', message: res?.error || 'Print failed.' });
      setCurrentPrintingFileIndex(null);
    }
  } catch (e) {
    setPrintStatus({ type: 'error', message: e?.message || 'Print request failed.' });
    setCurrentPrintingFileIndex(null);
  } finally {
    setPrinting(false);
  }
};
```

---

## 🎯 Visual Indicators

### File Status Indicators

Your existing UI already shows file status. The progress callbacks will automatically update:

```javascript
// In your file grid rendering
{print_files?.map((file, index) => {
  const isCurrentlyPrinting = printing && currentPrintingFileIndex === index;
  const isQueuedForPrinting = printing && currentPrintingFileIndex !== null && index >= currentPrintingFileIndex;
  const isCompleted = printing && currentPrintingFileIndex !== null && index < currentPrintingFileIndex;
  
  return (
    <div className={`
      ${isCurrentlyPrinting ? 'border-[var(--primary-color)] ring-2' : ''}
      ${isCompleted ? 'opacity-60' : ''}
    `}>
      {isCurrentlyPrinting && (
        <div className="badge">Printing...</div>
      )}
      {isCompleted && (
        <div className="badge">✓ Printed</div>
      )}
      {isQueuedForPrinting && !isCurrentlyPrinting && (
        <div className="badge">Queued</div>
      )}
    </div>
  );
})}
```

---

## 📊 Progress Flow Example

For a print job with 3 files:

```
File 0: downloading → converting → rendering → printing → completed
File 1: downloading → rendering → printing → completed
File 2: downloading → rendering → printing → completed
```

Progress events:
1. `{ fileIndex: 0, status: 'downloading', ... }`
2. `{ fileIndex: 0, status: 'converting', ... }` (if DOCX/XLSX)
3. `{ fileIndex: 0, status: 'rendering', ... }`
4. `{ fileIndex: 0, status: 'printing', ... }`
5. `{ fileIndex: 0, status: 'completed', ... }`
6. `{ fileIndex: 1, status: 'downloading', ... }`
7. ... and so on

---

## 🔧 Advanced Usage

### Track Detailed Progress

```javascript
const [printProgress, setPrintProgress] = useState({});

onProgress: (progress) => {
  setPrintProgress(prev => ({
    ...prev,
    [progress.fileIndex]: {
      status: progress.status,
      message: progress.message,
      url: progress.url
    }
  }));
  
  // Show detailed status for each file
  console.log(`File ${progress.fileIndex + 1}: ${progress.status} - ${progress.message}`);
}
```

### Show Progress Percentage

```javascript
const [progressPercent, setProgressPercent] = useState(0);

onProgress: (progress) => {
  if (progress.status === 'completed') {
    const percent = ((progress.fileIndex + 1) / progress.totalFiles) * 100;
    setProgressPercent(percent);
  }
}
```

---

## ✅ Benefits

1. **Real-time Updates** - Know exactly which file is printing
2. **Better UX** - Users see progress instead of waiting blindly
3. **Error Handling** - Get immediate feedback on failures
4. **Visual Feedback** - Highlight current file in file grid
5. **Status Messages** - Show detailed status (downloading, converting, etc.)

---

## 🎉 Summary

Your frontend can now:
- ✅ Track which file is currently printing
- ✅ Show real-time status updates
- ✅ Display progress for each file
- ✅ Handle errors per file
- ✅ Update UI indicators automatically

Just add the `onProgress` callback to your `window.hostego.print()` call!
