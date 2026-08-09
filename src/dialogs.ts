import { spawn } from "node:child_process";

const VIDEO_FILTER = "Video Files|*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.wmv|All Files|*.*";

export async function pickInputVideo(): Promise<string | null> {
  return runDialog(`
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = 'Select input video'
    $dialog.Filter = '${VIDEO_FILTER}'
    $dialog.CheckFileExists = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.FileName
    }
  `);
}

export async function pickOutputVideo(defaultFileName: string): Promise<string | null> {
  return runDialog(`
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Title = 'Choose output video location'
    $dialog.Filter = '${VIDEO_FILTER}'
    $dialog.FileName = '${escapeSingleQuotes(defaultFileName)}'
    $dialog.OverwritePrompt = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.FileName
    }
  `);
}

export async function pickFolder(description: string): Promise<string | null> {
  return runDialog(`
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = '${escapeSingleQuotes(description)}'
    $dialog.ShowNewFolderButton = $true
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
    }
  `);
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "''");
}

// Dialogs run out-of-process via PowerShell/WinForms since Node has no built-in native file picker.
async function runDialog(script: string): Promise<string | null> {
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", encodedScript],
      { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to open dialog: ${error.message}`));
    });

    child.once("close", (code) => {
      if (code !== 0 && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }

      const result = stdout.trim();
      resolve(result.length > 0 ? result : null);
    });
  });
}
