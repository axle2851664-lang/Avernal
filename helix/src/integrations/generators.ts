import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GenerationResult {
  success: boolean;
  path?: string;
  /** Path the server serves the file from, e.g. /generated_images/image_42.png. */
  url?: string;
  filename?: string;
  prompt: string;
  error?: string;
  device?: string;
  seed?: number;
  frames?: number;
}

// The server runs from dist/, but tsc does not emit the .py files; they stay in src/.
const scriptDir = join(__dirname, '..', '..', 'src', 'integrations');

function spawnPython(scriptName: string, args: string[]): Promise<GenerationResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(scriptDir, scriptName);
    const python = spawn('python3', [scriptPath, ...args]);

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0 && stdout) {
        try {
          resolve(JSON.parse(stdout) as GenerationResult);
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout}`));
        }
      } else {
        reject(new Error(stderr || `Process exited with code ${code}`));
      }
    });

    python.on('error', (err) => {
      reject(err);
    });
  });
}

/** A bare filename is not reachable from a browser; point at the static route. */
function withUrl(result: GenerationResult, route: string): GenerationResult {
  if (result.filename === undefined) return result;
  return { ...result, url: `/${route}/${result.filename}` };
}

export async function generateImage(
  prompt: string,
  steps: number = 20,
  guidance: number = 7.5,
  seed: number = Math.floor(Math.random() * 1000000)
): Promise<GenerationResult> {
  const result = await spawnPython('image_generator.py', [
    prompt,
    steps.toString(),
    guidance.toString(),
    seed.toString(),
  ]);
  return withUrl(result, 'generated_images');
}

export async function generateVideo(
  prompt: string,
  frames: number = 8,
  steps: number = 25,
  seed: number = Math.floor(Math.random() * 1000000)
): Promise<GenerationResult> {
  const result = await spawnPython('video_generator.py', [
    prompt,
    frames.toString(),
    steps.toString(),
    seed.toString(),
  ]);
  return withUrl(result, 'generated_videos');
}
