import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface GenerationResult {
  success: boolean;
  path?: string;
  filename?: string;
  prompt: string;
  error?: string;
  device?: string;
  seed?: number;
  frames?: number;
}

function spawnPython(scriptName: string, args: string[]): Promise<GenerationResult> {
  return new Promise((resolve, reject) => {
    const scriptPath = join(__dirname, scriptName);
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

export async function generateImage(
  prompt: string,
  steps: number = 20,
  guidance: number = 7.5,
  seed: number = Math.floor(Math.random() * 1000000)
): Promise<GenerationResult> {
  return spawnPython('image_generator.py', [prompt, steps.toString(), guidance.toString(), seed.toString()]);
}

export async function generateVideo(
  prompt: string,
  frames: number = 8,
  steps: number = 25,
  seed: number = Math.floor(Math.random() * 1000000)
): Promise<GenerationResult> {
  return spawnPython('video_generator.py', [prompt, frames.toString(), steps.toString(), seed.toString()]);
}
