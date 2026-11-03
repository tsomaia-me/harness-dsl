import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import PQueue from 'p-queue';
import treeKill from 'tree-kill';
import type { CommandExecOptions, CommandExecResult, Runner } from './types.js';

export interface LocalRunnerOptions {
  readonly id?: string;
  readonly maxConcurrentSlots?: number;
  readonly slotPortBase?: number;
  readonly portsPerSlot?: number;
  readonly slotEnv?: (slotIndex: number, ports: readonly number[]) => Record<string, string>;
  readonly timeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
}

export interface SshHealthSnapshot {
  readonly loadRatio: number;
  readonly freeDiskGb: number;
}

export interface SshRunnerOptions extends LocalRunnerOptions {
  readonly host: string;
  readonly workDir: string;
  readonly maxCpuLoadRatio?: number;
  readonly minFreeDiskGb?: number;
  readonly sshBinary?: string;
  /** The private key `ssh -i` signs in with; the agent's keys serve when none is given. */
  readonly identityFile?: string;
  readonly skipPreFlightCheck?: boolean;
  readonly healthProbeFn?: (host: string, workDir: string) => Promise<SshHealthSnapshot>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class InactivityTimeoutError extends Error {
  public readonly partialOutput: string;

  public constructor(command: string, inactivityTimeoutMs: number, partialOutput: string) {
    super(`Command timed out after ${inactivityTimeoutMs}ms of inactivity: ${command}`);
    this.name = 'InactivityTimeoutError';
    this.partialOutput = partialOutput;
  }
}

export class CommandTimeoutError extends Error {
  public readonly partialOutput: string;

  public constructor(command: string, timeoutMs: number, partialOutput: string) {
    super(`Command exceeded total timeout of ${timeoutMs}ms: ${command}`);
    this.name = 'CommandTimeoutError';
    this.partialOutput = partialOutput;
  }
}

export class RunnerDiskLowError extends Error {
  public readonly host: string;
  public readonly freeDiskGb: number;
  public readonly minFreeDiskGb: number;

  public constructor(host: string, freeDiskGb: number, minFreeDiskGb: number) {
    super(
      `Runner "${host}" free disk (${freeDiskGb.toFixed(2)} GB) is below minimum (${minFreeDiskGb} GB)`,
    );
    this.name = 'RunnerDiskLowError';
    this.host = host;
    this.freeDiskGb = freeDiskGb;
    this.minFreeDiskGb = minFreeDiskGb;
  }
}

export class RunnerLoadHighError extends Error {
  public readonly host: string;
  public readonly loadRatio: number;
  public readonly maxCpuLoadRatio: number;

  public constructor(host: string, loadRatio: number, maxCpuLoadRatio: number) {
    super(
      `Runner "${host}" CPU load ratio (${loadRatio.toFixed(2)}) exceeds maximum (${maxCpuLoadRatio})`,
    );
    this.name = 'RunnerLoadHighError';
    this.host = host;
    this.loadRatio = loadRatio;
    this.maxCpuLoadRatio = maxCpuLoadRatio;
  }
}

export function killProcessGroupAndTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      void err;
    }
    treeKill(pid, 'SIGKILL', () => {
      resolve();
    });
  });
}

abstract class BaseSlotRunner implements Runner {
  public readonly id: string;
  public abstract readonly kind: 'local' | 'ssh';
  protected readonly maxConcurrentSlots: number;
  protected readonly slotPortBase: number;
  protected readonly portsPerSlot: number;
  private readonly slotEnv?: (slotIndex: number, ports: readonly number[]) => Record<string, string>;
  protected readonly defaultTimeoutMs: number;
  protected readonly defaultInactivityTimeoutMs: number;
  private readonly queue: PQueue;
  private readonly occupiedSlots = new Set<number>();

  public constructor(id: string, opts?: LocalRunnerOptions) {
    this.id = id;
    this.maxConcurrentSlots = opts?.maxConcurrentSlots ?? 2;
    this.slotPortBase = opts?.slotPortBase ?? 18000;
    this.portsPerSlot = opts?.portsPerSlot ?? 10;
    this.slotEnv = opts?.slotEnv;
    this.defaultTimeoutMs = opts?.timeoutMs ?? 10 * 60_000;
    this.defaultInactivityTimeoutMs = opts?.inactivityTimeoutMs ?? 2 * 60_000;
    this.queue = new PQueue({ concurrency: this.maxConcurrentSlots });
  }

  protected allocateSlot(): { slotIndex: number; slotPorts: readonly number[] } {
    for (let i = 0; i < this.maxConcurrentSlots; i += 1) {
      if (!this.occupiedSlots.has(i)) {
        this.occupiedSlots.add(i);
        return { slotIndex: i, slotPorts: this.portsForSlot(i) };
      }
    }
    throw new Error(`No free slot available on runner ${this.id}`);
  }

  protected portsForSlot(slotIndex: number): number[] {
    const base = this.slotPortBase + slotIndex * this.portsPerSlot;
    return Array.from({ length: this.portsPerSlot }, (_, idx) => base + idx);
  }

  protected releaseSlot(slotIndex: number): void {
    this.occupiedSlots.delete(slotIndex);
  }

  protected buildSlotEnv(
    slotIndex: number,
    slotPorts: readonly number[],
    extraEnv?: Record<string, string>,
  ): Record<string, string> {
    return {
      HARNESS_SLOT: String(slotIndex),
      PORT: String(slotPorts[0]),
      ...this.slotEnv?.(slotIndex, slotPorts),
      ...extraEnv,
    };
  }

  public async exec(
    command: string,
    opts?: CommandExecOptions,
  ): Promise<CommandExecResult & { slotIndex: number; slotPorts: readonly number[] }> {
    return this.queue.add(async () => {
      const { slotIndex, slotPorts } = this.allocateSlot();
      try {
        const res = await this.execInSlot(command, slotIndex, slotPorts, opts);
        return { ...res, slotIndex, slotPorts };
      } finally {
        this.releaseSlot(slotIndex);
      }
    }) as Promise<CommandExecResult & { slotIndex: number; slotPorts: readonly number[] }>;
  }

  protected abstract execInSlot(
    command: string,
    slotIndex: number,
    slotPorts: readonly number[],
    opts?: CommandExecOptions,
  ): Promise<CommandExecResult>;

  protected runSpawnedProcess(
    executable: string,
    args: readonly string[],
    displayCommand: string,
    opts: {
      cwd?: string;
      env: Record<string, string>;
      timeoutMs: number;
      inactivityTimeoutMs: number;
      reject: boolean;
      signal?: AbortSignal;
    },
  ): Promise<CommandExecResult> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn(executable, args, {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...opts.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let all = '';
      let settled = false;

      const clearTimers = () => {
        if (totalTimer) clearTimeout(totalTimer);
        if (inactivityTimer) clearTimeout(inactivityTimer);
      };

      let inactivityTimer: NodeJS.Timeout | undefined;
      const resetInactivity = () => {
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (child.pid) await killProcessGroupAndTree(child.pid);
          reject(new InactivityTimeoutError(displayCommand, opts.inactivityTimeoutMs, all));
        }, opts.inactivityTimeoutMs);
      };

      const totalTimer = setTimeout(async () => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (child.pid) await killProcessGroupAndTree(child.pid);
        reject(new CommandTimeoutError(displayCommand, opts.timeoutMs, all));
      }, opts.timeoutMs);

      resetInactivity();

      if (opts.signal) {
        const onAbort = async () => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (child.pid) await killProcessGroupAndTree(child.pid);
          reject(new Error(`Command aborted: ${displayCommand}`));
        };
        if (opts.signal.aborted) {
          void onAbort();
          return;
        }
        opts.signal.addEventListener('abort', () => void onAbort(), { once: true });
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        all += text;
        resetInactivity();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stderr += text;
        all += text;
        resetInactivity();
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(err);
      });

      child.on('close', async (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (child.pid) {
          await killProcessGroupAndTree(child.pid);
        }
        const exitCode = code ?? 1;
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (exitCode !== 0 && opts.reject) {
          const error = new Error(
            `Command failed with exit code ${exitCode}: ${displayCommand}\n${all.slice(-2000)}`,
          );
          reject(error);
          return;
        }
        resolve({
          exitCode,
          stdout,
          stderr,
          all,
          durationMs,
        });
      });
    });
  }
}

export class LocalRunner extends BaseSlotRunner {
  public readonly kind = 'local' as const;

  public constructor(opts?: LocalRunnerOptions) {
    super(opts?.id ?? 'local', opts);
  }

  protected async execInSlot(
    command: string,
    slotIndex: number,
    slotPorts: readonly number[],
    opts?: CommandExecOptions,
  ): Promise<CommandExecResult> {
    const slotEnv = this.buildSlotEnv(slotIndex, slotPorts, opts?.env);
    return this.runSpawnedProcess('/bin/sh', ['-c', command], command, {
      cwd: opts?.cwd,
      env: slotEnv,
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
      inactivityTimeoutMs: opts?.inactivityTimeoutMs ?? this.defaultInactivityTimeoutMs,
      reject: opts?.reject ?? true,
      signal: opts?.signal,
    });
  }
}

export class SshRunner extends BaseSlotRunner {
  public readonly kind = 'ssh' as const;
  public readonly host: string;
  public readonly workDir: string;
  public readonly maxCpuLoadRatio: number;
  public readonly minFreeDiskGb: number;
  private readonly sshBinary: string;
  private readonly identityFile: string | undefined;
  private readonly skipPreFlightCheck: boolean;
  private readonly healthProbeFn?: (host: string, workDir: string) => Promise<SshHealthSnapshot>;

  public constructor(id: string, opts: SshRunnerOptions) {
    super(id, opts);
    this.host = opts.host;
    this.workDir = opts.workDir;
    this.maxCpuLoadRatio = opts.maxCpuLoadRatio ?? 1.5;
    this.minFreeDiskGb = opts.minFreeDiskGb ?? 5;
    this.sshBinary = opts.sshBinary ?? 'ssh';
    this.identityFile = opts.identityFile;
    this.skipPreFlightCheck = opts.skipPreFlightCheck ?? false;
    this.healthProbeFn = opts.healthProbeFn;
  }

  private getMuxFlags(): string[] {
    const controlDir = path.join(homedir(), '.harness');
    mkdirSync(controlDir, { recursive: true });
    const controlPath = path.join(controlDir, 'ssh-%r@%h:%p.sock');
    return [
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=auto',
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ControlPersist=10m',
      '-o',
      'ServerAliveInterval=5',
      '-o',
      'ServerAliveCountMax=2',
      ...(this.identityFile ? ['-i', this.identityFile] : []),
    ];
  }

  /** The remote command runs in `cwd`, or in the host's work directory when the command names none. */
  public buildSshCommandArgs(
    command: string,
    slotIndex: number,
    extraEnv?: Record<string, string>,
    cwd?: string,
  ): string[] {
    const envVars = this.buildSlotEnv(slotIndex, this.portsForSlot(slotIndex), extraEnv);
    const exports = Object.entries(envVars).map(([name, value]) => {
      if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name "${name}"`);
      return `export ${name}=${shellQuote(value)};`;
    });
    const script = [
      'trap "kill -TERM -$$ 2>/dev/null; sleep 0.2; kill -KILL -$$ 2>/dev/null" EXIT INT TERM HUP;',
      `cd ${shellQuote(cwd ?? this.workDir)} &&`,
      ...exports,
      command,
    ].join(' ');
    const remoteWrapper = `setsid bash -c ${shellQuote(script)}`;

    return [...this.getMuxFlags(), this.host, remoteWrapper];
  }

  public async checkRemoteHealth(): Promise<SshHealthSnapshot> {
    const snapshot = this.healthProbeFn
      ? await this.healthProbeFn(this.host, this.workDir)
      : await this.defaultProbeRemoteHealth();

    if (snapshot.freeDiskGb < this.minFreeDiskGb) {
      throw new RunnerDiskLowError(this.host, snapshot.freeDiskGb, this.minFreeDiskGb);
    }
    if (snapshot.loadRatio > this.maxCpuLoadRatio) {
      throw new RunnerLoadHighError(this.host, snapshot.loadRatio, this.maxCpuLoadRatio);
    }
    return snapshot;
  }

  private async defaultProbeRemoteHealth(): Promise<SshHealthSnapshot> {
    const probeScript = [
      'LOAD=$(cat /proc/loadavg 2>/dev/null | awk "{print \\$1}" || sysctl -n vm.loadavg 2>/dev/null | awk "{print \\$2}" || echo 0);',
      'CORES=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1);',
      `FREE_KB=$(df -Pk ${this.workDir} 2>/dev/null | tail -1 | awk "{print \\$4}" || echo 104857600);`,
      'echo "$LOAD $CORES $FREE_KB"',
    ].join(' ');

    const res = await this.runSpawnedProcess(
      this.sshBinary,
      [...this.getMuxFlags(), this.host, probeScript],
      `ssh ${this.host} health-check`,
      {
        env: {},
        timeoutMs: 15_000,
        inactivityTimeoutMs: 10_000,
        reject: true,
      },
    );

    const parts = res.stdout.trim().split(/\s+/);
    const load = Number(parts[0] ?? 0) || 0;
    const cores = Math.max(1, Number(parts[1] ?? 1) || 1);
    const freeKb = Number(parts[2] ?? 104_857_600) || 0;
    return {
      loadRatio: load / cores,
      freeDiskGb: freeKb / (1024 * 1024),
    };
  }

  protected async execInSlot(
    command: string,
    slotIndex: number,
    _slotPorts: readonly number[],
    opts?: CommandExecOptions,
  ): Promise<CommandExecResult> {
    if (!this.skipPreFlightCheck) {
      await this.checkRemoteHealth();
    }
    const sshArgs = this.buildSshCommandArgs(command, slotIndex, opts?.env, opts?.cwd);
    return this.runSpawnedProcess(this.sshBinary, sshArgs, `ssh ${this.host}: ${command}`, {
      env: {},
      timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs,
      inactivityTimeoutMs: opts?.inactivityTimeoutMs ?? this.defaultInactivityTimeoutMs,
      reject: opts?.reject ?? true,
      signal: opts?.signal,
    });
  }
}
