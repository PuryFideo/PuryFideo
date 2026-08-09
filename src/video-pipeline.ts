import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export type JobState = "queued" | "running" | "completed" | "failed";

export type JobRequest = {
  inputPath: string;
  outputPath?: string;
  tempDir?: string;
};

export type RuntimeConfig = {
  projectRoot: string;
  tempDirName: string;
  outputSuffix: string;
  cleanupTemp: boolean;
  ffmpegPath: string;
  ffprobePath: string;
};

export type JobSnapshot = {
  id: string;
  inputPath: string;
  outputPath: string;
  tempDir: string;
  status: JobState;
  progress: number;
  message: string;
  frameRate: number | null;
  totalFrames: number;
  processedFrames: number;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
};

type InternalJob = JobSnapshot;

type PuryFiConnection = {
  sendMessage(type: string, payload: unknown): Promise<any>;
};

export class VideoJobManager {
  private readonly queue: InternalJob[] = [];
  private readonly history: InternalJob[] = [];
  private processing = false;
  private currentJob: InternalJob | null = null;

  public constructor(
    private readonly getConnection: () => PuryFiConnection | null,
    private readonly getConfig: () => RuntimeConfig,
    private readonly setStatus: (message: string) => void
  ) {}

  public enqueue(request: JobRequest): JobSnapshot {
    const job = this.createJob(request);
    this.queue.push(job);
    this.setStatus(`Queued ${path.basename(job.inputPath)} for censorship.`);
    void this.processQueue();
    return this.toSnapshot(job);
  }

  public getState(): {
    busy: boolean;
    queueLength: number;
    currentJob: JobSnapshot | null;
    recentJobs: JobSnapshot[];
  } {
    return {
      busy: this.processing,
      queueLength: this.queue.length,
      currentJob: this.currentJob ? this.toSnapshot(this.currentJob) : null,
      recentJobs: this.history.slice(0, 8).map((job) => this.toSnapshot(job)),
    };
  }

  private createJob(request: JobRequest): InternalJob {
    const normalizedInput = path.resolve(request.inputPath.trim());
    const outputPath = request.outputPath?.trim() ? path.resolve(request.outputPath.trim()) : "";
    const tempDir = request.tempDir?.trim() ? path.resolve(request.tempDir.trim()) : "";

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      inputPath: normalizedInput,
      outputPath,
      tempDir,
      status: "queued",
      progress: 0,
      message: "Waiting in queue.",
      frameRate: null,
      totalFrames: 0,
      processedFrames: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }

  private toSnapshot(job: InternalJob): JobSnapshot {
    return { ...job };
  }

  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) {
          break;
        }

        this.currentJob = job;
        await this.runJob(job);
        this.history.unshift({ ...job });
        this.history.splice(8);
        this.currentJob = null;
      }
    } finally {
      this.processing = false;
    }
  }

  private async runJob(job: InternalJob): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();

    const config = this.getConfig();
    const outputPath = job.outputPath || buildOutputPath(job.inputPath, config.outputSuffix);
    const tempRoot = job.tempDir || buildTempPath(job.inputPath, config.tempDirName);
    const framesDir = path.join(tempRoot, "frames-src");
    const censoredFramesDir = path.join(tempRoot, "frames-censored");
    let cleanupTemp = config.cleanupTemp;

    job.outputPath = outputPath;
    job.tempDir = tempRoot;

    try {
      const connection = this.getConnection();
      if (!connection) {
        throw new Error("PuryFI is not connected. Register ws://localhost:8080 in PuryFI and wait for the handshake to finish.");
      }

      await ensureReadableFile(job.inputPath);
      await ensureDirectoryExists(path.dirname(outputPath));
      await fs.mkdir(framesDir, { recursive: true });
      await fs.mkdir(censoredFramesDir, { recursive: true });

      const ffmpegPath = await resolveExecutable(config.projectRoot, config.ffmpegPath, "ffmpeg.exe", "ffmpeg");
      const ffprobePath = await resolveExecutable(config.projectRoot, config.ffprobePath, "ffprobe.exe", "ffprobe");

      job.message = "Probing source frame rate.";
      this.setStatus(`Probing ${path.basename(job.inputPath)}.`);
      job.frameRate = await probeFrameRate(ffprobePath, job.inputPath);

      job.message = "Extracting source frames.";
      this.setStatus(`Extracting frames from ${path.basename(job.inputPath)}.`);
      await runCommand(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        job.inputPath,
        "-vsync",
        "0",
        path.join(framesDir, "frame-%08d.png"),
      ]);

      const frameNames = await listFrameFiles(framesDir);
      if (frameNames.length === 0) {
        throw new Error("No frames were extracted from the input video.");
      }

      job.totalFrames = frameNames.length;
      job.message = `Censoring ${frameNames.length} extracted frames.`;
      this.setStatus(`Sending ${frameNames.length} frames through PuryFI.`);

      for (let index = 0; index < frameNames.length; index += 1) {
        const frameName = frameNames[index];
        const sourcePath = path.join(framesDir, frameName);
        const targetPath = path.join(censoredFramesDir, frameName);
        const sourceData = await fs.readFile(sourcePath);

        const result = await connection.sendMessage("censorStaticMedia", {
          image: new Uint8Array(sourceData),
          objects: null,
        });

        if (result.type === "error") {
          throw new Error(`PuryFI failed to censor ${frameName}: ${result.message}`);
        }

        await fs.writeFile(targetPath, Buffer.from(result.image));
        job.processedFrames = index + 1;
        job.progress = Math.round((job.processedFrames / job.totalFrames) * 100);

        if (job.processedFrames === 1 || job.processedFrames === job.totalFrames || job.processedFrames % 25 === 0) {
          job.message = `Censored ${job.processedFrames} of ${job.totalFrames} frames.`;
          this.setStatus(`${path.basename(job.inputPath)}: ${job.processedFrames}/${job.totalFrames} frames censored.`);
        }
      }

      job.message = "Rebuilding video with original audio.";
      this.setStatus(`Rebuilding ${path.basename(outputPath)}.`);
      await runCommand(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-framerate",
        String(job.frameRate),
        "-i",
        path.join(censoredFramesDir, "frame-%08d.png"),
        "-i",
        job.inputPath,
        "-map",
        "0:v:0",
        "-map",
        "1:a?",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        "-shortest",
        outputPath,
      ]);

      job.status = "completed";
      job.progress = 100;
      job.message = "Video processing completed.";
      this.setStatus(`Finished ${path.basename(outputPath)}.`);
    } catch (error) {
      cleanupTemp = false;
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      job.message = job.error;
      this.setStatus(`Job failed for ${path.basename(job.inputPath)}: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
      if (cleanupTemp) {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    }
  }
}

export function buildOutputPath(inputPath: string, outputSuffix: string): string {
  const directory = path.dirname(inputPath);
  const extension = path.extname(inputPath) || ".mp4";
  const baseName = path.basename(inputPath, extension);
  return path.join(directory, `${baseName}${outputSuffix}${extension}`);
}

function buildTempPath(inputPath: string, tempDirName: string): string {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return path.join(path.dirname(inputPath), tempDirName, `${baseName}-${stamp}`);
}

async function ensureReadableFile(filePath: string): Promise<void> {
  await fs.access(filePath);
}

async function ensureDirectoryExists(directoryPath: string): Promise<void> {
  const resolvedPath = path.resolve(directoryPath);
  const rootPath = path.parse(resolvedPath).root;
  if (resolvedPath === rootPath) {
    return;
  }

  await fs.mkdir(resolvedPath, { recursive: true });
}

async function listFrameFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function resolveExecutable(
  projectRoot: string,
  configuredPath: string,
  projectFileName: string,
  fallbackCommand: string
): Promise<string> {
  const explicit = configuredPath.trim();
  const fallbackProjectCandidates = [
    path.join(projectRoot, projectFileName),
    path.join(projectRoot, "bin", projectFileName),
  ];

  if (explicit && explicit !== fallbackCommand) {
    if (looksLikePath(explicit)) {
      await ensureReadableFile(explicit);
    }
    return explicit;
  }

  for (const candidate of fallbackProjectCandidates) {
    try {
      await ensureReadableFile(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  return explicit || fallbackCommand;
}

function looksLikePath(value: string): boolean {
  return value.includes("\\") || value.includes("/") || value.endsWith(".exe");
}

async function probeFrameRate(ffprobePath: string, inputPath: string): Promise<number> {
  const { stdout } = await runCommand(ffprobePath, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate,r_frame_rate",
    "-of",
    "json",
    inputPath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      avg_frame_rate?: string;
      r_frame_rate?: string;
    }>;
  };

  const stream = parsed.streams?.[0];
  const rate = parseFraction(stream?.avg_frame_rate) ?? parseFraction(stream?.r_frame_rate);
  if (!rate || !Number.isFinite(rate) || rate <= 0) {
    throw new Error("Could not determine a valid frame rate from ffprobe.");
  }

  return Number(rate.toFixed(6));
}

function parseFraction(value: string | undefined): number | null {
  if (!value || value === "0/0") {
    return null;
  }

  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText ?? "1");
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return numerator / denominator;
}

async function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      reject(new Error(`Failed to start ${command}: ${error.message}`));
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const details = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
      reject(new Error(`${path.basename(command)} failed: ${details}`));
    });
  });
}