import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DevicepoolError } from './index.ts';

const run = promisify(execFile);

export function missingFile(arg: string): DevicepoolError | null {
  if (!/[\\/]/.test(arg) && !/\.(app|apk|zip|tar)$/i.test(arg)) {
    return null;
  }
  return new DevicepoolError(0, 'NO_SUCH_FILE', `No such file: ${arg}.`, 'Check the path. To use a build Devicepool already has, pass its name without a path.');
}

export function deviceBuildProblem(path: string, platform: string | null): DevicepoolError | null {
  if (!platform || platform === 'iphonesimulator') {
    return null;
  }
  return new DevicepoolError(0, 'DEVICE_BUILD', `${path} is a device build.`, 'Build for the simulator: -sdk iphonesimulator.');
}

export async function checkSimulatorBuild(path: string): Promise<void> {
  if (!/\.app\/?$/.test(path)) {
    return;
  }
  const platform = await run('plutil', ['-extract', 'DTPlatformName', 'raw', '-o', '-', join(path, 'Info.plist')]).then((r) => r.stdout.trim(), () => null);
  const problem = deviceBuildProblem(path, platform);
  if (problem) {
    throw problem;
  }
}
