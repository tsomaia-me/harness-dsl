import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InactivityTimeoutError,
  LocalRunner,
  RunnerDiskLowError,
  RunnerLoadHighError,
  SshRunner,
} from '../../src/runner.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('LocalRunner & SshRunner Process Containment', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allocates distinct concurrency slots and deterministic port ranges across parallel jobs', async () => {
    const runner = new LocalRunner({
      maxConcurrentSlots: 2,
      slotPortBase: 19000,
      portsPerSlot: 3,
      slotEnv: (_slotIndex, ports) => ({ PORT_WEB: String(ports[1]) }),
    });
    const printEnv =
      'node -e "setTimeout(() => console.log([process.env.HARNESS_SLOT, process.env.PORT, process.env.PORT_WEB, process.env.PORT_API ?? \'unset\'].join(\':\')), 80)"';

    const [resA, resB] = await Promise.all([runner.exec(printEnv), runner.exec(printEnv)]);

    expect.soft(new Set([resA.slotIndex, resB.slotIndex])).toEqual(new Set([0, 1]));
    for (const res of [resA, resB]) {
      const base = 19000 + res.slotIndex * 3;
      expect.soft(res.slotPorts).toEqual([base, base + 1, base + 2]);
      expect.soft(res.stdout.trim()).toBe(`${res.slotIndex}:${base}:${base + 1}:unset`);
    }
  });

  it('passes env values with spaces, quotes and shell metacharacters through to the remote command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-ssh-env-'));
    tempDirs.push(dir);
    const shimDir = path.join(dir, 'bin');
    mkdirSync(shimDir);
    writeFileSync(path.join(shimDir, 'setsid'), '#!/bin/sh\nexec "$@"\n');
    chmodSync(path.join(shimDir, 'setsid'), 0o755);
    const runner = new SshRunner('box', { host: 'box.lan', workDir: path.join(dir, 'work dir'), skipPreFlightCheck: true });
    mkdirSync(path.join(dir, 'work dir'));
    const value = `--max-old-space-size=4096 --title='it''s' ; echo pwned $HOME`;
    const remoteLine = runner.buildSshCommandArgs('printf %s "$PORT|$NODE_OPTIONS"', 1, { NODE_OPTIONS: value }).at(-1)!;

    const stdout = execFileSync('/bin/sh', ['-c', remoteLine], {
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(stdout).toBe(`18010|${value}`);
  });

  it('kills the entire child process tree when inactivityTimeoutMs fires', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-runner-kill-'));
    tempDirs.push(dir);
    const scriptPath = path.join(dir, 'spawn-orphan.mjs');
    writeFileSync(
      scriptPath,
      [
        "import { spawn } from 'node:child_process';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'console.log(String(child.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
      'utf8',
    );

    const runner = new LocalRunner({
      maxConcurrentSlots: 1,
      inactivityTimeoutMs: 250,
      timeoutMs: 10_000,
    });

    let capturedOutput = '';
    await expect(
      runner.exec(`${process.execPath} ${scriptPath}`, {
        cwd: dir,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (err instanceof InactivityTimeoutError) {
        capturedOutput = err.partialOutput;
        return true;
      }
      return false;
    });

    const grandchildPid = Number(capturedOutput.trim().split('\n')[0]);
    expect.soft(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);

    await waitFor(() => !isPidAlive(grandchildPid));
    expect(isPidAlive(grandchildPid)).toBe(false);
  });

  it('constructs agentless SSH ControlMaster arguments with setsid trap and enforces health check thresholds', async () => {
    const sshRunner = new SshRunner('wb2', {
      host: 'wb2',
      workDir: '/srv/harness/CrookedDuke',
      maxConcurrentSlots: 2,
      slotPortBase: 18100,
    });

    const args = sshRunner.buildSshCommandArgs('pnpm test', 1, { CUSTOM_VAR: 'yes' });
    expect.soft(args).toContain('ControlMaster=auto');
    expect.soft(args).toContain('wb2');
    const remoteScript = args[args.length - 1]!;
    expect.soft(remoteScript).toContain('setsid');
    expect.soft(remoteScript).toContain('kill -TERM -$$');
    expect.soft(remoteScript).toContain('/srv/harness/CrookedDuke');

    const lowDiskRunner = new SshRunner('wb2-disk', {
      host: 'wb2',
      workDir: '/srv/harness/CrookedDuke',
      minFreeDiskGb: 20,
      healthProbeFn: async () => ({ freeDiskGb: 5.5, loadRatio: 0.4 }),
    });
    await expect(lowDiskRunner.checkRemoteHealth()).rejects.toBeInstanceOf(RunnerDiskLowError);

    const highLoadRunner = new SshRunner('wb2-load', {
      host: 'wb2',
      workDir: '/srv/harness/CrookedDuke',
      maxCpuLoadRatio: 2.0,
      healthProbeFn: async () => ({ freeDiskGb: 50, loadRatio: 3.5 }),
    });
    await expect(highLoadRunner.checkRemoteHealth()).rejects.toBeInstanceOf(RunnerLoadHighError);
  });
});
