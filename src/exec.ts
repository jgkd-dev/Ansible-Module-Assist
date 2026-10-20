import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Directories that commonly hold ansible executables but are often missing
 * from VS Code's PATH (e.g. when launched from a dock / start menu).
 */
function extraBinDirs(workspaceFolders: string[]): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  for (const ws of workspaceFolders) {
    for (const venv of ['.venv', 'venv', 'env', '.env']) {
      dirs.push(path.join(ws, venv, process.platform === 'win32' ? 'Scripts' : 'bin'));
    }
  }
  dirs.push(
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  );
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

export class AnsibleCli {
  private env: NodeJS.ProcessEnv;
  private binDir?: string;

  constructor(binDir: string | undefined, workspaceFolders: string[], private timeoutMs = 20000) {
    this.binDir = binDir && binDir.trim() ? expandHome(binDir.trim()) : undefined;
    const pathParts = [
      ...(this.binDir ? [this.binDir] : []),
      ...extraBinDirs(workspaceFolders),
      ...(process.env.PATH ?? '').split(path.delimiter),
    ];
    this.env = {
      ...process.env,
      PATH: Array.from(new Set(pathParts.filter(Boolean))).join(path.delimiter),
      ANSIBLE_NOCOLOR: '1',
      ANSIBLE_FORCE_COLOR: '0',
      ANSIBLE_DEPRECATION_WARNINGS: 'False',
    };
  }

  private resolve(cmd: string): string {
    if (this.binDir) {
      const candidate = path.join(this.binDir, cmd);
      if (fs.existsSync(candidate)) return candidate;
    }
    return cmd;
  }

  /** Runs an ansible CLI tool. Resolves to stdout, or null if it failed or isn't installed. */
  run(cmd: string, args: string[], cwd?: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        execFile(
          this.resolve(cmd),
          args,
          { env: this.env, cwd, timeout: this.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (err, stdout) => resolve(err && !stdout ? null : stdout.toString()),
        );
      } catch {
        resolve(null);
      }
    });
  }
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}
