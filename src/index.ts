import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { PluginConfiguration, PluginIntent, PluginManifest } from "@pury-fi/plugin-sdk";
import { WebSocketServer } from "@pury-fi/plugin-sdk/websocket";
import { VideoJobManager, buildOutputPath } from "./video-pipeline.js";
import { pickFolder, pickInputVideo, pickOutputVideo } from "./dialogs.js";

type AppConfig = {
  httpPort: number;
  pluginPort: number;
  projectRoot: string;
  tempDirName: string;
  outputSuffix: string;
  cleanupTemp: boolean;
  ffmpegPath: string;
  ffprobePath: string;
};

const appConfig: AppConfig = {
  httpPort: 8090,
  pluginPort: 8080,
  projectRoot: process.cwd(),
  tempDirName: "tmp",
  outputSuffix: "-censored",
  cleanupTemp: true,
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
};

let pluginConfiguration: PluginConfiguration = {
  ffmpegPath: {
    name: "FFmpeg Path",
    type: "string",
    value: appConfig.ffmpegPath,
  },
  ffprobePath: {
    name: "FFprobe Path",
    type: "string",
    value: appConfig.ffprobePath,
  },
  outputSuffix: {
    name: "Output Suffix",
    type: "string",
    value: appConfig.outputSuffix,
  },
  tempDirName: {
    name: "Temp Folder Name",
    type: "string",
    value: appConfig.tempDirName,
  },
  cleanupTemp: {
    name: "Cleanup Temp Files",
    type: "boolean",
    value: appConfig.cleanupTemp,
  },
};

const manifest: PluginManifest = {
  name: "PuryFideo",
  version: "0.1.0",
  description: "Local video processing pipeline that censors extracted frames through PuryFI.",
  author: null,
  website: null,
};

const intents: PluginIntent[] = ["requestMediaProcesses"];

let activeConnection: any = null;
let lastStatus = "Waiting for PuryFI to connect.";
const jobManager = new VideoJobManager(
  () => activeConnection,
  () => ({ ...appConfig }),
  (message) => {
    lastStatus = message;
  }
);

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PuryFideo</title>
    <style>
      :root {
        color-scheme: dark;
        --main-background-color: #0B0E11;
        --secondary-background-color: #151719;
        --secondary-background-color-variant-1: #2C3135;
        --secondary-background-color-variant-2: #212428;
        --main-accent-color: #009879;
        --main-accent-color-variant-1: #017A62;
        --main-accent-color-variant-2: #0B5E50;
        --main-accent-color-variant-3: #213E3A;
        --main-accent-color-variant-4: #4AC193;
        --main-input-color: #2C3135;
        --main-input-color-variant-1: #1F2A2D;
        --main-border-color: #BBC9DF;
        --border-color-variant-1: #646D78;
        --border-color-variant-2: #3A3F45;
        --main-text-color: #BBC9DF;
        --main-text-color-disabled: #BBC9DF99;
        --main-text-color-variant-1: #EEE;
        --header-text-color: #009879;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Arial, Helvetica, sans-serif;
        background: var(--main-background-color);
        color: var(--main-text-color);
      }
      main {
        max-width: 760px;
        margin: 40px auto;
        padding: 24px;
      }
      .panel {
        background: var(--secondary-background-color);
        border: 1px solid var(--border-color-variant-2);
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
      }
      h1 {
        margin-top: 0;
        color: var(--header-text-color);
      }
      .status {
        padding: 12px 14px;
        border-radius: 10px;
        background: var(--secondary-background-color-variant-2);
        border: 1px solid var(--border-color-variant-2);
        margin-bottom: 20px;
        color: var(--main-text-color-variant-1);
      }
      form {
        display: grid;
        gap: 14px;
        margin: 20px 0 28px;
      }
      label {
        display: grid;
        gap: 6px;
        font-size: 0.95rem;
        color: var(--main-text-color);
      }
      .path-row {
        display: flex;
        gap: 8px;
      }
      input {
        width: 100%;
        padding: 12px 14px;
        border-radius: 10px;
        border: 1px solid var(--border-color-variant-2);
        background: var(--main-input-color);
        color: var(--main-text-color-variant-1);
      }
      input[readonly] {
        cursor: default;
        color: var(--main-text-color);
      }
      button {
        width: fit-content;
        padding: 12px 18px;
        border: none;
        border-radius: 999px;
        background: var(--main-accent-color);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }
      button:hover {
        background: var(--main-accent-color-variant-4);
      }
      button.secondary {
        background: var(--secondary-background-color-variant-1);
        color: var(--main-text-color-variant-1);
        border: 1px solid var(--border-color-variant-2);
        padding: 12px 16px;
        white-space: nowrap;
      }
      button.secondary:hover {
        background: var(--main-input-color-variant-1);
      }
      .meta {
        color: var(--main-text-color-disabled);
        font-size: 0.95rem;
      }
      .job {
        border: 1px solid var(--border-color-variant-2);
        border-radius: 12px;
        padding: 14px;
        margin-top: 12px;
        background: var(--secondary-background-color-variant-2);
      }
      .progress {
        height: 10px;
        border-radius: 999px;
        background: var(--main-input-color);
        overflow: hidden;
        margin-top: 10px;
      }
      .progress > span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, var(--main-accent-color-variant-1), var(--main-accent-color-variant-4));
      }
      code {
        background: var(--main-input-color);
        color: var(--main-text-color-variant-1);
        padding: 2px 6px;
        border-radius: 6px;
      }
      p { line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>PuryFideo</h1>
        <div class="status" id="plugin-status">${escapeHtml(lastStatus)}</div>
        <p>Register this as a WebSocket plugin in PuryFI using <code>ws://localhost:${appConfig.pluginPort}</code>.</p>
        <p>Drop <code>ffmpeg.exe</code> and <code>ffprobe.exe</code> into this project root or set their full paths in the PuryFI plugin configuration.</p>

        <form id="job-form">
          <label>
            Input video
            <div class="path-row">
              <input name="inputPath" id="input-path" placeholder="No file selected" readonly required />
              <button type="button" class="secondary" data-dialog="input">Browse...</button>
            </div>
          </label>
          <label>
            Output video
            <div class="path-row">
              <input name="outputPath" id="output-path" placeholder="Optional. Defaults to source name + ${escapeHtml(appConfig.outputSuffix)}" readonly />
              <button type="button" class="secondary" data-dialog="output">Browse...</button>
              <button type="button" class="secondary" data-clear="output-path">Clear</button>
            </div>
          </label>
          <label>
            Temp working folder
            <div class="path-row">
              <input name="tempDir" id="temp-path" placeholder="Optional. Defaults beside the source video" readonly />
              <button type="button" class="secondary" data-dialog="temp">Browse...</button>
              <button type="button" class="secondary" data-clear="temp-path">Clear</button>
            </div>
          </label>
          <button type="submit">Process Video</button>
        </form>

        <p class="meta" id="queue-meta">Loading status...</p>
        <section id="job-list"></section>
      </section>
    </main>
    <script>
      const form = document.getElementById("job-form");
      const pluginStatus = document.getElementById("plugin-status");
      const queueMeta = document.getElementById("queue-meta");
      const jobList = document.getElementById("job-list");
      const inputPathField = document.getElementById("input-path");
      const outputPathField = document.getElementById("output-path");
      const tempPathField = document.getElementById("temp-path");

      document.querySelectorAll("[data-dialog]").forEach((button) => {
        button.addEventListener("click", async () => {
          const kind = button.getAttribute("data-dialog");
          button.disabled = true;
          const previousLabel = button.textContent;
          button.textContent = "Waiting for dialog...";
          try {
            const response = await fetch('/api/dialogs/' + kind, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ inputPath: inputPathField.value }),
            });
            const data = await response.json();
            if (!response.ok) {
              pluginStatus.textContent = data.error || 'Failed to open dialog.';
              return;
            }
            if (data.path) {
              if (kind === 'input') inputPathField.value = data.path;
              if (kind === 'output') outputPathField.value = data.path;
              if (kind === 'temp') tempPathField.value = data.path;
            }
          } catch (error) {
            pluginStatus.textContent = String(error);
          } finally {
            button.disabled = false;
            button.textContent = previousLabel;
          }
        });
      });

      document.querySelectorAll("[data-clear]").forEach((button) => {
        button.addEventListener("click", () => {
          const field = document.getElementById(button.getAttribute("data-clear"));
          field.value = "";
        });
      });

      function renderJob(job, heading) {
        if (!job) {
          return "";
        }

        const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
        const safe = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        return '<div class="job">' +
          '<strong>' + safe(heading) + '</strong><br />' +
          safe(job.status) + ' - ' + safe(job.message) + '<br />' +
          'Input: ' + safe(job.inputPath) + '<br />' +
          'Output: ' + safe(job.outputPath) + '<br />' +
          (job.error ? 'Error: ' + safe(job.error) + '<br />' : '') +
          '<div class="progress"><span style="width:' + progress + '%"></span></div>' +
          '</div>';
      }

      async function refreshStatus() {
        const response = await fetch('/api/status');
        const data = await response.json();
        pluginStatus.textContent = data.pluginStatus;
        queueMeta.textContent = 'Connected: ' + (data.connected ? 'yes' : 'no') + ' | Queue: ' + data.jobs.queueLength + ' | Busy: ' + (data.jobs.busy ? 'yes' : 'no');

        const sections = [];
        if (data.jobs.currentJob) {
          sections.push(renderJob(data.jobs.currentJob, 'Current job'));
        }
        for (const job of data.jobs.recentJobs) {
          sections.push(renderJob(job, 'Recent job'));
        }
        jobList.innerHTML = sections.join('') || '<p class="meta">No jobs yet.</p>';
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const formData = new FormData(form);
        const payload = {
          inputPath: String(formData.get('inputPath') || '').trim(),
          outputPath: String(formData.get('outputPath') || '').trim(),
          tempDir: String(formData.get('tempDir') || '').trim(),
        };

        const response = await fetch('/api/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();
        if (!response.ok) {
          pluginStatus.textContent = data.error || 'Failed to queue job.';
          return;
        }

        pluginStatus.textContent = 'Queued ' + data.job.inputPath;
        form.reset();
        await refreshStatus();
      });

      refreshStatus();
      setInterval(() => {
        refreshStatus().catch((error) => {
          pluginStatus.textContent = String(error);
        });
      }, 1500);
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }

  return JSON.parse(body);
}

function applyConfiguration(configuration: PluginConfiguration): void {
  appConfig.ffmpegPath = readStringField(configuration, "ffmpegPath", appConfig.ffmpegPath);
  appConfig.ffprobePath = readStringField(configuration, "ffprobePath", appConfig.ffprobePath);
  appConfig.outputSuffix = readStringField(configuration, "outputSuffix", appConfig.outputSuffix);
  appConfig.tempDirName = readStringField(configuration, "tempDirName", appConfig.tempDirName);
  appConfig.cleanupTemp = readBooleanField(configuration, "cleanupTemp", appConfig.cleanupTemp);
}

function readStringField(configuration: PluginConfiguration, key: string, fallback: string): string {
  const field = configuration[key];
  return field && typeof field.value === "string" && field.value.trim() ? field.value.trim() : fallback;
}

function readBooleanField(configuration: PluginConfiguration, key: string, fallback: boolean): boolean {
  const field = configuration[key];
  return field && typeof field.value === "boolean" ? field.value : fallback;
}

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${appConfig.httpPort}`}`);

  if (req.method === "GET" && requestUrl.pathname === "/") {
    sendHtml(res, renderPage());
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/status") {
    sendJson(res, 200, {
      connected: Boolean(activeConnection),
      pluginStatus: lastStatus,
      projectRoot: appConfig.projectRoot,
      jobs: jobManager.getState(),
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname.startsWith("/api/dialogs/")) {
    const kind = requestUrl.pathname.slice("/api/dialogs/".length);
    try {
      const payload = await readJsonBody(req);
      const referenceInput = typeof payload.inputPath === "string" ? payload.inputPath : "";

      let selectedPath: string | null;
      if (kind === "input") {
        selectedPath = await pickInputVideo();
      } else if (kind === "output") {
        const defaultName = referenceInput ? path.basename(buildOutputPath(referenceInput, appConfig.outputSuffix)) : "output.mp4";
        selectedPath = await pickOutputVideo(defaultName);
      } else if (kind === "temp") {
        selectedPath = await pickFolder("Select a temp working folder");
      } else {
        sendJson(res, 404, { error: `Unknown dialog '${kind}'.` });
        return;
      }

      sendJson(res, 200, { path: selectedPath });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/jobs") {
    try {
      const payload = await readJsonBody(req);
      if (!payload.inputPath || typeof payload.inputPath !== "string") {
        sendJson(res, 400, { error: "inputPath is required." });
        return;
      }

      const job = jobManager.enqueue({
        inputPath: payload.inputPath,
        outputPath: typeof payload.outputPath === "string" ? payload.outputPath : undefined,
        tempDir: typeof payload.tempDir === "string" ? payload.tempDir : undefined,
      });
      sendJson(res, 202, { job });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: `No route for ${req.method ?? "GET"} ${requestUrl.pathname}` });
}

async function ensureIntents(connection: any): Promise<void> {
  const granted = await connection.sendMessage("getPluginIntents", {}).then((res: any) => {
    if (res.type === "error") {
      throw new Error(`Failed to get plugin intents: ${res.message}`);
    }
    return res.intents as string[];
  });

  if (intents.every((intent) => granted.includes(intent))) {
    return;
  }

  await connection.sendMessage("requestPluginIntents", { intents }).then((res: any) => {
    if (res.type === "error") {
      throw new Error(`Failed to request plugin intents: ${res.message}`);
    }
  });

  await new Promise<void>((resolve) => {
    connection.on("message", "intentsGrant", function listener(payload: any) {
      if (intents.every((intent) => payload.intents.includes(intent))) {
        connection.off("message", "intentsGrant", listener);
        resolve();
      }
    });
  });
}

async function initializeConnection(connection: any): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.once("message", "ready", (payload: any) => {
      const result = connection.handleReadyMessage(payload);
      if (result.type === "ok") {
        resolve();
      }
      return result;
    });
  });

  await connection.sendMessage("setPluginManifest", { manifest }).then((res: any) => {
    if (res.type === "error") {
      throw new Error(`Failed to set plugin manifest: ${res.message}`);
    }
  });

  await connection.sendMessage("setPluginConfiguration", { configuration: pluginConfiguration }).then((res: any) => {
    if (res.type === "error") {
      throw new Error(`Failed to set plugin configuration: ${res.message}`);
    }
  });

  applyConfiguration(pluginConfiguration);

  connection.on("message", "configurationChange", (payload: any) => {
    pluginConfiguration = payload.configuration;
    applyConfiguration(pluginConfiguration);
  });

  await ensureIntents(connection);
}

function startPluginServer(): void {
  const server = new WebSocketServer(appConfig.pluginPort);
  server.on("connection", (connection: any) => {
    activeConnection = connection;
    lastStatus = "PuryFI connected. Handshake in progress.";

    connection.once("open", async () => {
      try {
        await initializeConnection(connection);
        lastStatus = "Connected to PuryFI. Ready to process videos.";
      } catch (error) {
        lastStatus = `Connection initialization failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });

    connection.on("close", () => {
      if (activeConnection === connection) {
        activeConnection = null;
      }
      lastStatus = "PuryFI disconnected. Waiting for reconnection.";
    });
  });
}

function startHttpServer(): void {
  const server = createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.listen(appConfig.httpPort, () => {
    lastStatus = `Waiting for PuryFI at ws://localhost:${appConfig.pluginPort}. Control page at http://localhost:${appConfig.httpPort}.`;
  });
}

function main(): void {
  startPluginServer();
  startHttpServer();
}

main();