import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { COMPUTER_KEYS, type ComputerAction, type ComputerCapture, type ComputerDisplay, type ComputerEdgeDriver } from './computer-edge-types.ts';

export const LINUX_DESKTOP_HELPER = '/usr/local/libexec/opendots-linux-desktop';
export const desktopLimits = Object.freeze({ width: 4096, height: 2160, pixels: 8_847_360, pngBytes: 16 * 1024 * 1024, metadataBytes: 16_384, actionMs: 10_000, captureMs: 5000, textBytes: 16_384, events: 16_384 });
export class LinuxDesktopError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'LinuxDesktopError'; this.code = code; }
}
export interface DesktopContext { signal: AbortSignal; assertCurrent: () => void }
export interface NativeDesktopExecutor {
  capture(args: readonly string[], env: Readonly<Record<string, string>>, context: DesktopContext): Promise<Buffer>;
  /** Checks the epoch immediately before EACH bounded native gesture. An
   * admitted press/release completes its own release; never queue characters. */
  action(args: readonly string[], env: Readonly<Record<string, string>>, context: DesktopContext): Promise<Buffer>;
}
export type DesktopSpawner = (executable: string, args: readonly string[], options: { env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe']; shell: false }) => ChildProcessWithoutNullStreams;
interface NativeMetadata {
  protocol: 1; display: string; displayGeneration: string; width: number; height: number;
  roundTrip: true; inputStateVerified: true; heldKeys: number[]; heldButtons: number[]; pngBytes: number; cancelled?: boolean;
}
export interface LinuxCapture extends ComputerCapture { displayGeneration: string; observationId: string; inputUncertain?: boolean }
export interface LinuxDesktopOptions {
  display: string;
  /** Operator-supplied X authority file; never a tool/browser input. */
  xauthority: string;
  /** Changes on browser replacement; supervisor must revoke control on death. */
  browserInstanceId: string;
  assertBrowserCurrent: () => void;
  executor?: NativeDesktopExecutor;
  now?: () => number;
}
const freshContext = (): DesktopContext => ({ signal: new AbortController().signal, assertCurrent() {} });
function check(condition: unknown, code: string): asserts condition { if (!condition) throw new LinuxDesktopError(code); }
function current(context: DesktopContext) { if (context.signal.aborted) throw new LinuxDesktopError('desktop_aborted'); try { context.assertCurrent(); } catch (error) { throw error instanceof LinuxDesktopError ? error : new LinuxDesktopError('desktop_control_revoked'); } }
function boundedInteger(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum; }
function exact(object: object, keys: string[]) { check(Object.keys(object).length === keys.length && Object.keys(object).every(key => keys.includes(key)), 'invalid_desktop_action'); }

/** No shell, executable, path, URL, CDP, modifier chord or raw keycode input. */
export function desktopActionArguments(action: ComputerAction, display: ComputerDisplay): string[] {
  check(Boolean(action) && typeof action === 'object', 'invalid_desktop_action');
  switch (action.type) {
    case 'move': case 'click':
      exact(action, action.type === 'click' ? ['type', 'x', 'y', 'button'] : ['type', 'x', 'y']);
      check(boundedInteger(action.x, 0, display.width - 1) && boundedInteger(action.y, 0, display.height - 1), 'desktop_coordinates_out_of_bounds');
      if (action.type === 'move') return ['move', String(action.x), String(action.y)];
      check(['left', 'middle', 'right'].includes(action.button), 'invalid_desktop_button');
      return ['click', String(action.x), String(action.y), action.button];
    case 'scroll':
      exact(action, ['type', 'direction', 'pixels']);
      check(['up', 'down', 'left', 'right'].includes(action.direction) && boundedInteger(action.pixels, 1, 1000), 'invalid_desktop_scroll');
      // X11 core wheel events are discrete; do not promise pixel-exact movement.
      return ['scroll', action.direction, String(Math.ceil(action.pixels / 100))];
    case 'key':
      exact(action, ['type', 'key']); check((COMPUTER_KEYS as readonly string[]).includes(action.key), 'invalid_desktop_key');
      return ['key', action.key];
    case 'type':
      exact(action, ['type', 'text']);
      check(typeof action.text === 'string' && action.text.length > 0 && action.text.length <= 4096 && Buffer.byteLength(action.text, 'utf8') <= desktopLimits.textBytes && !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(action.text), 'invalid_desktop_text');
      return ['type', Buffer.from(action.text, 'utf8').toString('hex')];
    default: throw new LinuxDesktopError('invalid_desktop_action');
  }
}

/** One permit admits one bounded gesture (click, key, character, or wheel
 * detent). Revocation finishes ONLY that owned gesture and stops before next. */
export class SpawnDesktopExecutor implements NativeDesktopExecutor {
  private spawnChild: DesktopSpawner;
  constructor(spawnChild: DesktopSpawner = (executable, args, options) => spawn(executable, [...args], options)) { this.spawnChild = spawnChild; }
  capture(args: readonly string[], env: Readonly<Record<string, string>>, context: DesktopContext) { return this.run(args, env, context, false); }
  action(args: readonly string[], env: Readonly<Record<string, string>>, context: DesktopContext) { return this.run(args, env, context, true); }
  private run(args: readonly string[], env: Readonly<Record<string, string>>, context: DesktopContext, interactive: boolean): Promise<Buffer> {
    current(context);
    return new Promise((resolve, reject) => {
      const argv = [...args];
      const textPrelude = interactive && argv.length === 6 && argv[4] === 'type' ? argv.pop()! : undefined;
      // Text travels over the private pipe, never process argv/command errors.
      const child = this.spawnChild(LINUX_DESKTOP_HELPER, argv, { env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      const chunks: Buffer[] = []; let bytes = 0, pending = '', granted = 0, total: number | undefined, done: Buffer | undefined, failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      let cancellationRequested = false, stopSent = false;
      const fail = (error: Error) => { if (!failure) failure = error; child.stdin.destroy(); child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250); };
      const aborted = () => { cancellationRequested = true; if (!interactive) fail(new LinuxDesktopError('desktop_aborted')); };
      const timer = setTimeout(() => fail(new LinuxDesktopError('desktop_helper_timeout')), interactive ? desktopLimits.actionMs : desktopLimits.captureMs);
      context.signal.addEventListener('abort', aborted, { once: true });
      if (context.signal.aborted) aborted();
      child.on('error', () => { failure = new LinuxDesktopError('desktop_helper_spawn_failed'); }); child.stdin.on('error', () => { if (!failure) failure = new LinuxDesktopError('desktop_helper_input_closed'); });
      child.stderr.on('data', () => {}); // Never publish screenshots/text/paths from stderr.
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (interactive ? 4 * 1024 * 1024 : desktopLimits.pngBytes + desktopLimits.metadataBytes)) return fail(new LinuxDesktopError('desktop_helper_output_too_large'));
        if (!interactive) { chunks.push(chunk); return; }
        pending += chunk.toString('utf8');
        if (pending.length > desktopLimits.metadataBytes) return fail(new LinuxDesktopError('desktop_helper_protocol_invalid'));
        let lineEnd;
        while ((lineEnd = pending.indexOf('\n')) !== -1 && !failure) {
          const line = pending.slice(0, lineEnd); pending = pending.slice(lineEnd + 1);
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            if ('ready' in message) {
              // Native ack: prior gesture released and XSync completed.
              check(!done && !stopSent && message.ready === granted && boundedInteger(message.total, 1, desktopLimits.events) && granted < message.total && (total === undefined || total === message.total), 'desktop_helper_protocol_invalid');
              total = message.total;
              try { current(context); } catch { cancellationRequested = true; }
              if (cancellationRequested) { stopSent = true; child.stdin.write('stop\n'); }
              else { child.stdin.write('emit\n'); granted++; }
            } else {
              check(!done && message.done === true && total !== undefined && (granted === total || (stopSent && message.cancelled === true && granted < total)), 'desktop_helper_protocol_invalid');
              done = Buffer.from(line + '\n'); child.stdin.end();
            }
          } catch (error) { fail(error instanceof LinuxDesktopError ? error : new LinuxDesktopError('desktop_helper_protocol_invalid')); }
        }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer); context.signal.removeEventListener('abort', aborted);
        if (failure) return reject(failure);
        if (code !== 0 || signal !== null) return reject(new LinuxDesktopError('desktop_helper_failed'));
        if (interactive && (!done || pending)) return reject(new LinuxDesktopError('desktop_helper_protocol_invalid'));
        resolve(interactive ? done! : Buffer.concat(chunks));
      });
      if (textPrelude !== undefined) child.stdin.write(textPrelude + '\n');
    });
  }
}

function metadata(buffer: Buffer, display: string): { value: NativeMetadata; rest: Buffer } {
  const end = buffer.indexOf(10); check(end > 0 && end < desktopLimits.metadataBytes, 'desktop_metadata_invalid');
  let value: NativeMetadata;
  try { value = JSON.parse(buffer.subarray(0, end).toString('utf8')) as NativeMetadata; } catch { throw new LinuxDesktopError('desktop_metadata_invalid'); }
  check(value.protocol === 1 && value.display === display && /^[0-9a-f]{32}$/.test(value.displayGeneration) && value.roundTrip === true && value.inputStateVerified === true, 'desktop_metadata_invalid');
  check(boundedInteger(value.width, 1, desktopLimits.width) && boundedInteger(value.height, 1, desktopLimits.height) && value.width * value.height <= desktopLimits.pixels, 'desktop_dimensions_invalid');
  for (const inputs of [value.heldKeys, value.heldButtons]) check(Array.isArray(inputs) && inputs.length <= 256 && inputs.every(key => boundedInteger(key, 0, 255)), 'desktop_input_state_invalid');
  check(boundedInteger(value.pngBytes, 0, desktopLimits.pngBytes), 'desktop_png_invalid');
  return { value, rest: buffer.subarray(end + 1) };
}
function validatePng(png: Buffer, value: NativeMetadata) {
  check(png.length === value.pngBytes && png.length >= 33 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.readUInt32BE(8) === 13 && png.subarray(12, 16).toString() === 'IHDR' && png.readUInt32BE(16) === value.width && png.readUInt32BE(20) === value.height, 'desktop_png_invalid');
  // Only our trusted libpng helper produces data; no arbitrary image decoder or
  // browser-supplied bytes participate in the handoff fence.
}

export class LinuxDesktopDriver implements ComputerEdgeDriver {
  readonly displayName: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly executor: NativeDesktopExecutor;
  private readonly now: () => number;
  private readonly options: LinuxDesktopOptions;
  private nativeGeneration = '';
  private descriptor!: ComputerDisplay;
  private active = false;
  private uncertain = false;
  private constructor(options: LinuxDesktopOptions) {
    check(/^:[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(options.display), 'invalid_local_display');
    check(/^\/[A-Za-z0-9_./-]{1,500}$/.test(options.xauthority) && !options.xauthority.split('/').includes('..'), 'invalid_xauthority_configuration');
    check(/^[A-Za-z0-9_-]{8,128}$/.test(options.browserInstanceId) && typeof options.assertBrowserCurrent === 'function', 'browser_generation_required');
    this.options = options; this.displayName = options.display; this.executor = options.executor ?? new SpawnDesktopExecutor(); this.now = options.now ?? Date.now;
    this.env = Object.freeze({ DISPLAY: options.display, XAUTHORITY: options.xauthority, LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' });
  }
  static async connect(options: LinuxDesktopOptions): Promise<LinuxDesktopDriver> {
    const driver = new LinuxDesktopDriver(options);
    // Reopening must still permit HUMAN repair of a held state. The driver is
    // observable but input-faulted until an acknowledged held-free handback.
    await driver.readCapture(false, freshContext(), true); return driver;
  }
  display(): ComputerDisplay { return { ...this.descriptor }; }
  private context(context: DesktopContext): DesktopContext { return { signal: context.signal, assertCurrent: () => { try { this.options.assertBrowserCurrent(); } catch { throw new LinuxDesktopError('desktop_browser_replaced'); } current(context); } }; }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    check(!this.active, 'desktop_operation_in_flight'); this.active = true;
    try { return await operation(); } catch (error) { throw error instanceof LinuxDesktopError ? error : new LinuxDesktopError('desktop_native_io_failed'); } finally { this.active = false; }
  }
  private async readCapture(unheld: boolean, context: DesktopContext, initial = false): Promise<LinuxCapture> {
    current(this.context(context));
    let result: Buffer;
    try { result = await this.executor.capture(['--display', this.displayName, unheld ? 'capture-unheld' : 'capture'], this.env, this.context(context)); } catch (error) { throw error instanceof LinuxDesktopError ? error : new LinuxDesktopError('desktop_capture_failed'); }
    const { value, rest } = metadata(result, this.displayName); validatePng(rest, value);
    if (unheld) check(value.heldKeys.length === 0 && value.heldButtons.length === 0, 'desktop_input_still_held');
    if (initial) { this.nativeGeneration = value.displayGeneration; this.descriptor = { id: `${value.displayGeneration}:${this.options.browserInstanceId}`, width: value.width, height: value.height }; this.uncertain = value.heldKeys.length > 0 || value.heldButtons.length > 0; }
    else check(value.displayGeneration === this.nativeGeneration && value.width === this.descriptor.width && value.height === this.descriptor.height, 'desktop_generation_changed');
    current(this.context(context));
    return { ...this.display(), png: rest, capturedAt: this.now(), displayGeneration: value.displayGeneration, observationId: randomUUID(), inputUncertain: this.uncertain || value.heldKeys.length > 0 || value.heldButtons.length > 0 };
  }
  capture(context: DesktopContext): Promise<LinuxCapture> { return this.exclusive(() => this.readCapture(false, context)); }
  /** For transfer after the human process has cleanly stopped. Never releases
   * held inputs. Failed physical actions remain uncertain until explicit repair. */
  async inspectAndCaptureUnheld(context: DesktopContext = freshContext()): Promise<LinuxCapture> {
    check(!this.uncertain, 'desktop_action_uncertain'); return this.exclusive(() => this.readCapture(true, context));
  }
  /** Trusted human-return path ONLY, after its owned input process cleanly
   * closes. It clears the physical-input latch, never external-effect history. */
  async acknowledgeRepair(acknowledged: boolean, context: DesktopContext = freshContext()): Promise<LinuxCapture> {
    check(acknowledged === true, 'desktop_repair_acknowledgement_required');
    return this.exclusive(async () => {
      const capture = await this.readCapture(true, context);
      this.uncertain = false; return { ...capture, inputUncertain: false };
    });
  }
  async act(action: ComputerAction, context: DesktopContext): Promise<void> {
    check(!this.uncertain, 'desktop_action_uncertain');
    const args = desktopActionArguments(action, this.display()); // Reject before emissions.
    await this.exclusive(async () => {
      const safe = this.context(context); current(safe);
      // Planning and held-input checks occur natively before the first permit.
      let emitted = false;
      const guarded: DesktopContext = { signal: safe.signal, assertCurrent: () => { current(safe); emitted = true; } };
      try {
        const result = await this.executor.action(['--display', this.displayName, 'act', this.nativeGeneration, ...args], this.env, guarded);
        const { value, rest } = metadata(result, this.displayName);
        check(value.displayGeneration === this.nativeGeneration && value.width === this.descriptor.width && value.height === this.descriptor.height && rest.length === 0 && value.pngBytes === 0, 'desktop_generation_changed');
        check(value.heldKeys.length === 0 && value.heldButtons.length === 0, 'desktop_input_still_held');
        if (value.cancelled === true) throw new LinuxDesktopError('desktop_action_cancelled_settled');
      } catch (error) { if (emitted && !(error instanceof LinuxDesktopError && error.code === 'desktop_action_cancelled_settled')) this.uncertain = true; throw error; }
    });
  }
}
