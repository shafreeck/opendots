import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { LinuxDesktopDriver, LinuxDesktopError, SpawnDesktopExecutor, LINUX_DESKTOP_HELPER, desktopActionArguments, type DesktopContext, type NativeDesktopExecutor, type DesktopSpawner } from '../src/linux-desktop.ts';

const generation = '0123456789abcdef0123456789abcdef';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=', 'base64');
const meta = (overrides: object = {}) => ({ protocol: 1, display: ':99', displayGeneration: generation, width: 1, height: 1, roundTrip: true, inputStateVerified: true, heldKeys: [], heldButtons: [], pngBytes: png.length, ...overrides });
const envelope = (overrides: object = {}, bytes = png) => Buffer.concat([Buffer.from(JSON.stringify(meta(overrides)) + '\n'), bytes]);
const context = (): DesktopContext => ({ signal: new AbortController().signal, assertCurrent() {} });
const options = (executor: NativeDesktopExecutor) => ({ display: ':99', xauthority: '/tmp/opendots.Xauthority', browserInstanceId: 'browser-test-generation', assertBrowserCurrent() {}, executor });
function executorFixture() {
  const calls: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> = [];
  let response: Buffer = envelope();
  const executor: NativeDesktopExecutor = {
    async capture(args, env, ctx) { ctx.assertCurrent(); calls.push({ args, env }); return response; },
    async action(args, env, ctx) { ctx.assertCurrent(); calls.push({ args, env }); return envelope({ done: true, pngBytes: 0 }, Buffer.alloc(0)); },
  };
  return { executor, calls, setResponse(value: Buffer) { response = value; } };
}

test('Linux driver fixes same local DISPLAY, sanitizes environment, and exposes bounded PNG with stable generation', async () => {
  const fixture = executorFixture(); const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  assert.deepEqual(fixture.calls[0].args, ['--display', ':99', 'capture']);
  const image = await driver.capture(context());
  assert.equal(image.width, 1); assert.equal(image.height, 1); assert.equal(image.displayGeneration, generation);
  assert.deepEqual(image.png, png); assert.equal(image.id, driver.display().id); assert.match(image.observationId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(fixture.calls[0].env, { DISPLAY: ':99', XAUTHORITY: '/tmp/opendots.Xauthority', LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' });
  await driver.act({ type: 'click', x: 0, y: 0, button: 'left' }, context());
  assert.deepEqual(fixture.calls.at(-1)!.args, ['--display', ':99', 'act', generation, 'click', '0', '0', 'left']);
});

test('action schema rejects commands, URLs, raw keycodes, unknown fields, controls and off-screen coordinates before executor', async () => {
  const fixture = executorFixture(); const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  for (const bad of [{ type: 'shell', command: 'anything' }, { type: 'key', key: 'Control_L' }, { type: 'move', x: 1, y: 0 }, { type: 'click', x: 0, y: 0, button: 'left', executable: '/bin/sh' }, { type: 'type', text: 'line\n' }, { type: 'type', text: '\ud800' }, { type: 'scroll', direction: 'down', pixels: 1001 }]) await assert.rejects(driver.act(bad as never, context()), LinuxDesktopError);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(desktopActionArguments({ type: 'type', text: 'hello; $(not a command)' }, { id: 'd', width: 1, height: 1 }), ['type', Buffer.from('hello; $(not a command)').toString('hex')]);
  assert.deepEqual(desktopActionArguments({ type: 'scroll', direction: 'down', pixels: 250 }, { id: 'd', width: 1, height: 1 }), ['scroll', 'down', '3']);
  assert.deepEqual(desktopActionArguments({ type: 'key', key: 'Ctrl+L' }, { id: 'd', width: 1, height: 1 }), ['key', 'Ctrl+L']);
  assert.deepEqual(desktopActionArguments({ type: 'key', key: 'Ctrl+A' }, { id: 'd', width: 1, height: 1 }), ['key', 'Ctrl+A']);
  assert.throws(() => desktopActionArguments({ type: 'key', key: 'Ctrl+K' } as never, { id: 'd', width: 1, height: 1 }), /invalid_desktop_key/);
});

test('only operator-fixed local display and Xauthority configuration are accepted', async () => {
  const { executor } = executorFixture();
  for (const display of ['remote:0', ':99;cmd', ':12345', 'https://localhost', ':1.123']) await assert.rejects(LinuxDesktopDriver.connect({ ...options(executor), display }), /invalid_local_display/);
  await assert.rejects(LinuxDesktopDriver.connect({ ...options(executor), xauthority: '/tmp/../secret' }), /xauthority/);
});

test('dimension, generation, input-state and PNG corruption fail closed', async () => {
  const fixture = executorFixture(); const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  for (const overrides of [{ display: ':98' }, { displayGeneration: 'f'.repeat(32) }, { width: 99999 }, { pngBytes: 1 }, { roundTrip: false }, { inputStateVerified: false }, { heldKeys: [-1] }]) {
    fixture.setResponse(envelope(overrides)); await assert.rejects(driver.capture(context()), LinuxDesktopError);
  }
  fixture.setResponse(envelope({ heldKeys: [38] })); await assert.rejects(driver.inspectAndCaptureUnheld(), /desktop_input_still_held/);
  fixture.setResponse(envelope({ heldButtons: [7] })); await assert.rejects(driver.inspectAndCaptureUnheld(), /desktop_input_still_held/);
  assert.ok(fixture.calls.every(call => !call.args.includes('release')));
});

test('browser replacement and pre-aborted actions do not dispatch; action failure never reveals typed text', async () => {
  const fixture = executorFixture(); let browserAlive = true;
  const driver = await LinuxDesktopDriver.connect({ ...options(fixture.executor), assertBrowserCurrent() { if (!browserAlive) throw Error('private-browser-detail'); } });
  browserAlive = false; await assert.rejects(driver.act({ type: 'move', x: 0, y: 0 }, context()), /desktop_browser_replaced/);
  assert.equal(fixture.calls.length, 1); browserAlive = true;
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(driver.act({ type: 'move', x: 0, y: 0 }, { signal: aborted.signal, assertCurrent() {} }), /desktop_aborted/);
  const failing = { ...fixture.executor, async action(_args: readonly string[], _env: Readonly<Record<string, string>>, ctx: DesktopContext) { ctx.assertCurrent(); throw Error('spawn helper secret-typed-text stderr'); } };
  const uncertain = await LinuxDesktopDriver.connect(options(failing));
  await assert.rejects(uncertain.act({ type: 'type', text: 'secret-typed-text' }, context()), error => error instanceof LinuxDesktopError && error.message === 'desktop_native_io_failed');
  await assert.rejects(uncertain.inspectAndCaptureUnheld(), /desktop_action_uncertain/);
});

function protocolFixture(revoke: 'epoch' | 'abort') {
  const events: string[] = [], permits: string[] = [], kills: string[] = [];
  const controller = new AbortController(); let valid = true;
  const calls: Array<{ executable: string; args: readonly string[]; options: object }> = [];
  const spawn: DesktopSpawner = (executable, args, opts) => {
    calls.push({ executable, args, options: opts });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: (signal: string) => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit('close', null, signal)); return true; };
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const permit = String(chunk); done();
      if (permit === '6162\n') return; // Private text prelude, never argv.
      permits.push(permit);
      queueMicrotask(() => {
        if (permit === 'emit\n') {
          events.push('owned-key-down'); valid = false; if (revoke === 'abort') controller.abort();
          events.push('owned-key-up'); // One already-admitted bounded gesture.
          child.stdout.write(JSON.stringify({ ready: 1, total: 2 }) + '\n');
        } else if (permit === 'stop\n') {
          child.stdout.write(envelope({ done: true, cancelled: true, pngBytes: 0 }, Buffer.alloc(0)));
          queueMicrotask(() => child.emit('close', 0, null));
        }
      });
    } });
    queueMicrotask(() => child.stdout.write(JSON.stringify({ ready: 0, total: 2 }) + '\n'));
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawn, calls, events, permits, kills, context: { signal: controller.signal, assertCurrent() { if (!valid) throw Error('private-revocation-detail'); } } };
}
for (const kind of ['epoch', 'abort'] as const) test(`native protocol ${kind} revocation finishes only admitted release and never sends next character`, async () => {
  const fixture = protocolFixture(kind); const transport = new SpawnDesktopExecutor(fixture.spawn);
  const result = await transport.action(['--display', ':99', 'act', generation, 'type', '6162'], { DISPLAY: ':99' }, fixture.context);
  assert.equal(JSON.parse(result.toString()).cancelled, true);
  assert.deepEqual(fixture.events, ['owned-key-down', 'owned-key-up']); assert.deepEqual(fixture.permits, ['emit\n', 'stop\n']); assert.deepEqual(fixture.kills, []);
  assert.equal(fixture.calls[0].executable, LINUX_DESKTOP_HELPER); assert.equal((fixture.calls[0].options as { shell: boolean }).shell, false);
  assert.deepEqual(fixture.calls[0].args, ['--display', ':99', 'act', generation, 'type']);
});

test('cleanly cancelled gesture receipt permits held-free observation; crash stays sticky uncertain', async () => {
  const fixture = executorFixture();
  fixture.executor.action = async (_args, _env, ctx) => { ctx.assertCurrent(); return envelope({ done: true, cancelled: true, pngBytes: 0 }, Buffer.alloc(0)); };
  const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  await assert.rejects(driver.act({ type: 'type', text: 'ab' }, context()), /desktop_action_cancelled_settled/);
  assert.deepEqual((await driver.inspectAndCaptureUnheld()).png, png);
});

test('human repair may observe uncertain input; only explicit acknowledgement plus verified unheld capture clears physical latch', async () => {
  const fixture = executorFixture();
  fixture.executor.action = async (_args, _env, ctx) => { ctx.assertCurrent(); throw new LinuxDesktopError('desktop_helper_failed'); };
  const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  await assert.rejects(driver.act({ type: 'key', key: 'Enter' }, context()), /desktop_helper_failed/);
  await assert.rejects(driver.inspectAndCaptureUnheld(), /desktop_action_uncertain/);
  assert.deepEqual((await driver.capture(context())).png, png, 'Human read-only repair observation stays available');
  await assert.rejects(driver.acknowledgeRepair(false), /acknowledgement_required/);
  fixture.setResponse(envelope({ heldButtons: [1] }));
  await assert.rejects(driver.acknowledgeRepair(true), /desktop_input_still_held/);
  await assert.rejects(driver.inspectAndCaptureUnheld(), /desktop_action_uncertain/);
  fixture.setResponse(envelope()); await driver.acknowledgeRepair(true);
  assert.deepEqual((await driver.inspectAndCaptureUnheld()).png, png);
  assert.ok(fixture.calls.every(call => !call.args.includes('release')));
});

test('reopening on held input exposes read-only human repair instead of making the desktop inaccessible', async () => {
  const fixture = executorFixture(); fixture.setResponse(envelope({ heldKeys: [38] }));
  const driver = await LinuxDesktopDriver.connect(options(fixture.executor));
  assert.deepEqual((await driver.capture(context())).png, png);
  await assert.rejects(driver.act({ type: 'move', x: 0, y: 0 }, context()), /desktop_action_uncertain/);
  await assert.rejects(driver.inspectAndCaptureUnheld(), /desktop_action_uncertain/);
  fixture.setResponse(envelope()); await driver.acknowledgeRepair(true);
  await driver.act({ type: 'move', x: 0, y: 0 }, context());
});
