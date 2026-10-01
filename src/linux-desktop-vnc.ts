import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { LinuxDesktopError, type DesktopContext, type LinuxCapture, type LinuxDesktopDriver } from './linux-desktop.ts';

export const X11VNC_EXECUTABLE = '/usr/bin/x11vnc';
export interface ReviewedX11vncBuild { version: '0.9.16'; sha256: string }
export interface HumanVncExit { code: number | null; signal: NodeJS.Signals | null; spawnFailed?: boolean }
export interface OwnedHumanVncProcess {
  /** Resolves on close, not merely exit; no buffered process IO remains. */
  closed: Promise<HumanVncExit>;
  /** Owned process's source-verified PORT= announcement, not a foreign socket. */
  listeningPort: Promise<number>;
  signal(signal: 'SIGINT' | 'SIGKILL'): boolean;
}
export interface HumanVncExecutor {
  verify(build: ReviewedX11vncBuild): Promise<void>;
  portUnused(port: number): Promise<boolean>;
  ready(port: number): Promise<boolean>;
  spawn(args: readonly string[], env: Readonly<Record<string, string>>): OwnedHumanVncProcess;
}
function socketProbe(port: number, banner: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port }); let result = false, bytes = Buffer.alloc(0);
    socket.setTimeout(250);
    socket.on('connect', () => { if (!banner) socket.end(); });
    socket.on('data', chunk => { bytes = Buffer.concat([bytes, chunk]); if (bytes.length >= 12) { result = /^RFB 003\.(003|007|008)\n$/.test(bytes.subarray(0, 12).toString('ascii')); socket.destroy(); } if (bytes.length > 64) socket.destroy(); });
    socket.on('timeout', () => socket.destroy());
    socket.on('error', (error: NodeJS.ErrnoException) => { if (!banner && error.code === 'ECONNREFUSED') result = true; });
    socket.on('close', () => resolve(result));
  });
}
export class SpawnHumanVncExecutor implements HumanVncExecutor {
  async verify(build: ReviewedX11vncBuild): Promise<void> {
    try {
      const info = statSync(X11VNC_EXECUTABLE);
      if (!info.isFile() || info.size > 64 * 1024 * 1024 || createHash('sha256').update(readFileSync(X11VNC_EXECUTABLE)).digest('hex') !== build.sha256) throw new Error();
    } catch { throw new LinuxDesktopError('human_vnc_build_unverified'); }
    // Hash is the deployment's reviewed-build attestation; this extra version
    // check catches a mismatched declaration. No ambient rcfile/env is loaded.
    await new Promise<void>((resolve, reject) => {
      const child = spawn(X11VNC_EXECUTABLE, ['-norc', '-version'], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
      let bytes = ''; let failed = false;
      const timeout = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 2000);
      child.on('error', () => { failed = true; });
      for (const output of [child.stdout, child.stderr]) output.on('data', chunk => { bytes += String(chunk); if (bytes.length > 4096) { failed = true; child.kill('SIGKILL'); } });
      child.on('close', (code, signal) => { clearTimeout(timeout); if (!failed && code === 0 && signal === null && /\bx11vnc: 0\.9\.16\b/.test(bytes)) resolve(); else reject(new LinuxDesktopError('human_vnc_build_unverified')); });
    });
  }
  portUnused(port: number) { return socketProbe(port, false); }
  ready(port: number) { return socketProbe(port, true); }
  spawn(args: readonly string[], env: Readonly<Record<string, string>>): OwnedHumanVncProcess {
    const child = spawn(X11VNC_EXECUTABLE, [...args], { env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let spawnFailed = false, line = ''; child.on('error', () => { spawnFailed = true; });
    let announce!: (port: number) => void;
    const listeningPort = new Promise<number>(resolve => { announce = resolve; });
    child.stdout.on('data', chunk => {
      line += String(chunk); if (line.length > 4096) { line = ''; return; }
      let end; while ((end = line.indexOf('\n')) !== -1) { const value = line.slice(0, end); line = line.slice(end + 1); const match = /^PORT=([0-9]{1,5})$/.exec(value); if (match) announce(Number(match[1])); }
    });
    child.stderr.on('data', () => {});
    return { listeningPort, closed: new Promise(resolve => child.once('close', (code, signal) => { announce(0); resolve({ code, signal, spawnFailed }); })), signal: signal => child.kill(signal) };
  }
}
export interface HumanVncOptions {
  driver: Pick<LinuxDesktopDriver, 'displayName' | 'capture' | 'inspectAndCaptureUnheld' | 'acknowledgeRepair'>;
  display: string; xauthority: string; controlPort: number;
  /** This must be the separately configured read-only preview's display. */
  previewDisplay: string;
  reviewedBuild: ReviewedX11vncBuild;
  executor?: HumanVncExecutor;
  startTimeoutMs?: number; stopTimeoutMs?: number;
}
export interface HumanInputFence {
  capture: LinuxCapture;
  inputFence: 'settled';
  externalEffects: 'unknown';
}
export interface HumanVncHandle { readonly id: string }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); })]); }
  finally { clearTimeout(timer!); }
}

/** Owns only a dedicated human-input VNC child. It never restarts/kills Xvfb,
 * Chromium, or the independently view-only preview. Failure is sticky paused.
 * The gateway must revoke tickets/transport queues BEFORE invoking this fence. */
export class HumanVncLifecycle {
  private options: HumanVncOptions;
  private executor: HumanVncExecutor;
  private phase: 'stopped' | 'starting' | 'running' | 'stopping' | 'paused' = 'stopped';
  private process?: OwnedHumanVncProcess;
  private exit?: HumanVncExit;
  private displayId?: string;
  private handle?: HumanVncHandle;
  private uncertainty = false;
  private repairAcknowledgementRequired = false;
  constructor(options: HumanVncOptions) {
    if (!/^:[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(options.display) || options.previewDisplay !== options.display || options.driver.displayName !== options.display) throw new LinuxDesktopError('human_vnc_display_mismatch');
    if (!/^\/[A-Za-z0-9_./-]{1,500}$/.test(options.xauthority) || options.xauthority.split('/').includes('..') || !Number.isInteger(options.controlPort) || options.controlPort < 1024 || options.controlPort > 65535) throw new LinuxDesktopError('human_vnc_configuration_invalid');
    if (options.reviewedBuild?.version !== '0.9.16' || !/^[0-9a-f]{64}$/.test(options.reviewedBuild.sha256)) throw new LinuxDesktopError('human_vnc_build_unverified');
    for (const value of [options.startTimeoutMs, options.stopTimeoutMs]) if (value !== undefined && (!Number.isInteger(value) || value < 10 || value > 10_000)) throw new LinuxDesktopError('human_vnc_timeout_invalid');
    this.options = options; this.executor = options.executor ?? new SpawnHumanVncExecutor();
  }
  state() { return { status: this.phase, uncertainty: this.uncertainty, repairAcknowledgementRequired: this.repairAcknowledgementRequired, externalEffects: 'unknown' as const }; }
  async start(options: { repair?: boolean } = {}): Promise<HumanVncHandle> {
    if (this.phase === 'paused' && options.repair === true) {
      if (this.process && !this.exit) throw new LinuxDesktopError('human_vnc_previous_process_unconfirmed');
    } else if (this.phase !== 'stopped') throw new LinuxDesktopError('human_vnc_not_stopped');
    if (options.repair === true) { this.uncertainty = true; this.repairAcknowledgementRequired = true; }
    this.phase = 'starting';
    const handle = Object.freeze({ id: randomUUID() }); this.handle = handle;
    const stillStarting = () => { if (this.handle !== handle || this.phase !== 'starting') throw new LinuxDesktopError('human_vnc_start_revoked'); };
    try {
      await this.executor.verify(this.options.reviewedBuild);
      stillStarting();
      if (!await this.executor.portUnused(this.options.controlPort)) throw new LinuxDesktopError('human_vnc_port_in_use');
      stillStarting();
      // Human takeover is the recovery route: observing held/uncertain input is
      // allowed, but starting the human server never releases that input for us.
      const startingCapture = await this.options.driver.capture({ signal: new AbortController().signal, assertCurrent() {} });
      stillStarting();
      this.displayId = startingCapture.id;
      if (startingCapture.inputUncertain) { this.uncertainty = true; this.repairAcknowledgementRequired = true; }
      const args = ['-norc', '-display', this.options.display, '-auth', this.options.xauthority, '-listen', '127.0.0.1', '-localhost', '-no6', '-rfbport', String(this.options.controlPort), '-forever', '-shared', '-nopw', '-nosel', '-nosetprimary', '-nosetclipboard', '-noadd_keysyms', '-safer', '-nocmds'];
      this.process = this.executor.spawn(args, { DISPLAY: this.options.display, XAUTHORITY: this.options.xauthority, PATH: '/usr/bin:/bin', LANG: 'C' });
      this.exit = undefined;
      this.process.closed.then(exit => { if (this.handle !== handle) return; this.exit = exit; if (this.phase === 'running' || this.phase === 'starting') { this.phase = 'paused'; this.uncertainty = true; this.repairAcknowledgementRequired = true; } });
      const end = Date.now() + (this.options.startTimeoutMs ?? 5000);
      const announced = await bounded(this.process.listeningPort, this.options.startTimeoutMs ?? 5000);
      stillStarting();
      if (announced !== this.options.controlPort) throw new LinuxDesktopError('human_vnc_listener_unverified');
      while (Date.now() < end) {
        if (this.exit || this.phase !== 'starting') throw new LinuxDesktopError('human_vnc_unexpected_exit');
        if (await bounded(this.executor.ready(this.options.controlPort), Math.max(1, end - Date.now()))) {
          if (this.exit || this.phase !== 'starting') throw new LinuxDesktopError('human_vnc_unexpected_exit');
          this.phase = 'running'; return handle;
        }
        await delay(25);
      }
      throw new LinuxDesktopError('human_vnc_start_timeout');
    } catch (error) { if (this.handle === handle) { this.phase = 'paused'; this.uncertainty = true; this.repairAcknowledgementRequired = true; await this.terminateUncertain(); } throw error instanceof LinuxDesktopError ? error : new LinuxDesktopError('human_vnc_start_failed'); }
  }
  private async terminateUncertain() {
    if (!this.process || this.exit) return;
    try {
      this.process.signal('SIGINT');
      if (!await bounded(this.process.closed, this.options.stopTimeoutMs ?? 3000)) { this.process.signal('SIGKILL'); await bounded(this.process.closed, 500); }
    } catch { /* Uncertain cleanup cannot grant control or expose native errors. */ }
    // Cleanup of an uncertain child is never promoted to a successful fence.
  }
  async stopAndFence(handle: HumanVncHandle, options: { acknowledgeUncertainty?: boolean } = {}, context?: DesktopContext): Promise<HumanInputFence> {
    if (!handle || handle.id !== this.handle?.id) throw new LinuxDesktopError('human_vnc_stale_handle');
    if (this.phase !== 'running' || !this.process) throw new LinuxDesktopError('human_vnc_not_running');
    if (this.repairAcknowledgementRequired && options.acknowledgeUncertainty !== true) throw new LinuxDesktopError('human_vnc_uncertainty_acknowledgement_required');
    this.phase = 'stopping';
    try {
      // In reviewed x11vnc0.9.16, SIGINT sets shut_down for normal cleanup;
      // SIGTERM takes the emergency path. A signal exit is never clean exit.
      if (!this.process.signal('SIGINT')) throw new LinuxDesktopError('human_vnc_signal_failed');
      const exit = await bounded(this.process.closed, this.options.stopTimeoutMs ?? 3000);
      if (!exit) { this.process.signal('SIGKILL'); await bounded(this.process.closed, 500); throw new LinuxDesktopError('human_vnc_stop_timeout'); }
      if (exit.code !== 0 || exit.signal !== null || exit.spawnFailed) throw new LinuxDesktopError('human_vnc_unclean_exit');
      const capture = options.acknowledgeUncertainty === true
        ? await this.options.driver.acknowledgeRepair(true, context)
        : await this.options.driver.inspectAndCaptureUnheld(context);
      if (this.phase !== 'stopping' || this.handle?.id !== handle.id) throw new LinuxDesktopError('human_vnc_fence_revoked');
      if (capture.id !== this.displayId) throw new LinuxDesktopError('human_vnc_display_replaced');
      this.process = undefined; this.handle = undefined; this.phase = 'stopped';
      this.repairAcknowledgementRequired = false; // Past effect uncertainty remains.
      return { capture, inputFence: 'settled', externalEffects: 'unknown' };
    } catch (error) { this.phase = 'paused'; this.uncertainty = true; this.repairAcknowledgementRequired = true; await this.terminateUncertain(); throw error instanceof LinuxDesktopError ? error : new LinuxDesktopError('human_vnc_fence_failed'); }
  }
  async close(): Promise<void> { this.phase = 'paused'; await this.terminateUncertain(); }
}
