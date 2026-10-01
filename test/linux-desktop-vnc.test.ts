import test from 'node:test';
import assert from 'node:assert/strict';
import { HumanVncLifecycle, type HumanVncExecutor, type HumanVncExit, type HumanVncOptions } from '../src/linux-desktop-vnc.ts';
import { LinuxDesktopError, type LinuxCapture } from '../src/linux-desktop.ts';

const capture = (): LinuxCapture => ({ id: 'native-generation:browser-generation', observationId: 'fenced-observation', displayGeneration: '0'.repeat(32), width: 1, height: 1, capturedAt: Date.now(), png: new Uint8Array([1]) });
function fixture(overrides: { exit?: HumanVncExit | 'never'; ready?: boolean; unused?: boolean; verify?: () => Promise<void>; capture?: () => Promise<LinuxCapture> } = {}) {
  const signals: string[] = [], spawnArgs: Array<readonly string[]> = [], timeline: string[] = [];
  let resolveExit!: (exit: HumanVncExit) => void;
  let captures = 0;
  const executor: HumanVncExecutor = {
    async verify(build) { timeline.push('verify'); assert.equal(build.version, '0.9.16'); if (overrides.verify) await overrides.verify(); },
    async portUnused() { timeline.push('port-unused'); return overrides.unused ?? true; },
    async ready() { timeline.push('ready'); return overrides.ready ?? true; },
    spawn(args, env) {
      assert.equal(env.DISPLAY, ':99'); timeline.push('spawn'); spawnArgs.push(args);
      const closed = new Promise<HumanVncExit>(resolve => { resolveExit = resolve; });
      return { closed, listeningPort: Promise.resolve(5902), signal(signal) {
        signals.push(signal); timeline.push(signal);
        if (signal === 'SIGKILL') resolveExit({ code: null, signal: 'SIGKILL' });
        else if (overrides.exit !== 'never') { const result = overrides.exit ?? { code: 0, signal: null }; queueMicrotask(() => { timeline.push('clean-close'); resolveExit(result); }); }
        return true;
      } };
    },
  };
  const read = async (kind: string) => { timeline.push(kind); captures++; return overrides.capture ? overrides.capture() : capture(); };
  const options: HumanVncOptions = { display: ':99', previewDisplay: ':99', xauthority: '/tmp/opendots.Xauthority', controlPort: 5902, reviewedBuild: { version: '0.9.16', sha256: 'a'.repeat(64) }, executor, stopTimeoutMs: 20, startTimeoutMs: 25, driver: { displayName: ':99', capture: () => read('readonly-capture'), inspectAndCaptureUnheld: () => read('X-roundtrip-unheld-capture'), async acknowledgeRepair(acknowledged) { assert.equal(acknowledged, true); return read('acknowledged-unheld-repair'); } } };
  return { options, executor, signals, timeline, spawnArgs, captures: () => captures, crash: (exit: HumanVncExit) => resolveExit(exit) };
}

test('owned human VNC uses same display, fixed loopback/read-policy arguments and clean SIGINT before capture fence', async () => {
  const f = fixture(); const service = new HumanVncLifecycle(f.options); const handle = await service.start();
  assert.ok(Object.isFrozen(handle)); assert.match(handle.id, /^[a-f0-9-]{36}$/);
  const args = f.spawnArgs[0]; assert.ok(args.includes('-norc')); assert.ok(args.includes('-no6')); assert.ok(args.includes('-nosetclipboard')); assert.ok(args.includes('-nocmds'));
  assert.equal(args[args.indexOf('-display') + 1], ':99'); assert.equal(args[args.indexOf('-listen') + 1], '127.0.0.1'); assert.equal(args[args.indexOf('-rfbport') + 1], '5902');
  assert.ok(!args.includes('-clear_keys')); assert.ok(!args.includes('-clear_mods'));
  const result = await service.stopAndFence(handle);
  assert.deepEqual(f.signals, ['SIGINT']); assert.equal(result.inputFence, 'settled'); assert.equal(result.externalEffects, 'unknown');
  assert.equal(service.state().status, 'stopped');
  assert.ok(f.timeline.indexOf('clean-close') < f.timeline.lastIndexOf('X-roundtrip-unheld-capture'));
});

test('nonzero exit, signal termination and spawn failure can never count as settled', async () => {
  for (const exit of [{ code: 2, signal: null }, { code: null, signal: 'SIGINT' }, { code: 0, signal: null, spawnFailed: true }] as HumanVncExit[]) {
    const f = fixture({ exit }); const service = new HumanVncLifecycle(f.options); const handle = await service.start();
    await assert.rejects(service.stopAndFence(handle), /human_vnc_unclean_exit/);
    assert.equal(service.state().status, 'paused'); assert.equal(f.captures(), 1, 'No settled capture after unclean exit');
    await assert.rejects(service.start(), /human_vnc_not_stopped/);
  }
});

test('stop timeout forces owned child only and stays paused even after SIGKILL closes it', async () => {
  const f = fixture({ exit: 'never' }); const service = new HumanVncLifecycle(f.options); const handle = await service.start();
  await assert.rejects(service.stopAndFence(handle), /human_vnc_stop_timeout/);
  assert.deepEqual(f.signals, ['SIGINT', 'SIGKILL']); assert.equal(service.state().status, 'paused'); assert.equal(f.captures(), 1);
});

test('held input or display replacement after clean close remains paused; no synthetic release', async () => {
  for (const mode of ['held', 'replaced']) {
    let count = 0; const f = fixture({ async capture() { count++; if (count === 1) return capture(); if (mode === 'held') throw new LinuxDesktopError('desktop_input_still_held'); return { ...capture(), id: 'different-generation' }; } });
    const service = new HumanVncLifecycle(f.options); const handle = await service.start();
    await assert.rejects(service.stopAndFence(handle), mode === 'held' ? /input_still_held/ : /display_replaced/);
    assert.deepEqual(f.signals, ['SIGINT']); assert.equal(service.state().status, 'paused');
  }
});

test('old handle cannot signal a newer owned server and starts/stops never overlap', async () => {
  const f = fixture(); const service = new HumanVncLifecycle(f.options); const first = await service.start();
  await assert.rejects(service.start(), /human_vnc_not_stopped/);
  await service.stopAndFence(first); const second = await service.start();
  assert.notEqual(first.id, second.id);
  await assert.rejects(service.stopAndFence(first), /human_vnc_stale_handle/);
  assert.deepEqual(f.signals, ['SIGINT']); assert.equal(service.state().status, 'running');
  const stopping = service.stopAndFence(second);
  await assert.rejects(service.stopAndFence(second), /human_vnc_not_running/);
  await stopping; assert.deepEqual(f.signals, ['SIGINT', 'SIGINT']);
});

test('revoking startup before verification finishes never spawns a late human server', async () => {
  let verified!: () => void; const pending = new Promise<void>(resolve => { verified = resolve; });
  const f = fixture({ verify: () => pending }); const service = new HumanVncLifecycle(f.options); const starting = service.start();
  await service.close(); verified(); await assert.rejects(starting, /human_vnc_start_revoked/);
  assert.equal(f.spawnArgs.length, 0); assert.equal(service.state().status, 'paused');
});

test('preexisting listener, unreviewed build, wrong display and unknown failures fail closed without leaking raw details', async () => {
  const occupied = fixture({ unused: false }); const blocked = new HumanVncLifecycle(occupied.options);
  await assert.rejects(blocked.start(), /human_vnc_port_in_use/); assert.equal(occupied.spawnArgs.length, 0);
  assert.throws(() => new HumanVncLifecycle({ ...occupied.options, previewDisplay: ':98' }), /display_mismatch/);
  assert.throws(() => new HumanVncLifecycle({ ...occupied.options, reviewedBuild: { version: '0.9.16', sha256: '' } }), /build_unverified/);
  const privateError = fixture({ async verify() { throw Error('private xauthority path and secret'); } });
  await assert.rejects(new HumanVncLifecycle(privateError.options).start(), error => error instanceof LinuxDesktopError && error.message === 'human_vnc_start_failed');
});

test('unexpected clean process death is not a handoff fence', async () => {
  const f = fixture(); const service = new HumanVncLifecycle(f.options); const handle = await service.start();
  f.crash({ code: 0, signal: null }); await Promise.resolve();
  assert.equal(service.state().status, 'paused'); await assert.rejects(service.stopAndFence(handle), /human_vnc_not_running/);
  assert.equal(f.captures(), 1);
});

test('closing during the post-exit observation prevents a late successful fence', async () => {
  let resolveCapture!: (value: LinuxCapture) => void;
  const pending = new Promise<LinuxCapture>(resolve => { resolveCapture = resolve; });
  let count = 0; const f = fixture({ async capture() { return ++count === 1 ? capture() : pending; } });
  const service = new HumanVncLifecycle(f.options); const handle = await service.start();
  const stopping = service.stopAndFence(handle);
  while (count < 2) await new Promise(resolve => setImmediate(resolve));
  await service.close(); resolveCapture(capture());
  await assert.rejects(stopping, /human_vnc_fence_revoked/);
  assert.equal(service.state().status, 'paused');
});

test('explicit human repair can replace a confirmed-dead server but AI return requires acknowledgement', async () => {
  const f = fixture(); const service = new HumanVncLifecycle(f.options); const previous = await service.start();
  f.crash({ code: 2, signal: null }); await Promise.resolve();
  await assert.rejects(service.start(), /human_vnc_not_stopped/);
  const repair = await service.start({ repair: true }); assert.notEqual(repair.id, previous.id);
  assert.equal(service.state().uncertainty, true);
  await assert.rejects(service.stopAndFence(repair), /acknowledgement_required/);
  assert.equal(service.state().status, 'running'); assert.deepEqual(f.signals, []);
  const fenced = await service.stopAndFence(repair, { acknowledgeUncertainty: true });
  assert.equal(fenced.inputFence, 'settled'); assert.equal(service.state().uncertainty, true, 'Past effect uncertainty is not erased');
  assert.ok(f.timeline.indexOf('clean-close') < f.timeline.indexOf('acknowledged-unheld-repair'));
  assert.equal(f.timeline.filter(value => value === 'X-roundtrip-unheld-capture').length, 0, 'Human startup must use read-only capture');
});

test('human repair remains blocked when previous owned process closure cannot be confirmed', async () => {
  const f = fixture(); let spawns = 0;
  f.executor.spawn = () => { spawns++; return { closed: new Promise(() => {}), listeningPort: Promise.resolve(5902), signal() { return true; } }; };
  const service = new HumanVncLifecycle(f.options); await service.start(); await service.close();
  await assert.rejects(service.start({ repair: true }), /human_vnc_previous_process_unconfirmed/);
  assert.equal(spawns, 1);
});
