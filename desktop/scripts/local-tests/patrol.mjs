/** Fixed WebView2 route through the Desktop controls. Real models are developer-local. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNative } from '../benchmarks/native-run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const registry = join(root, 'benchmarks/l0/common-design-110kv.json');
const routes = { '110-A2-1': 'road', '110-A3-1': 'stairs', '110-B1-2': 'road' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
const arg = (key) => {
  const i = process.argv.indexOf(key);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function exercise(cdp, indoor, result) {
  const page = (fn, ...args) =>
    cdp.evaluate('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', undefined, 120000);
  const status = () =>
    page(() => ({
      mode: __gimAppState.navigation.mode,
      message: __gimAppState.navigation.message,
    }));
  const direction = () =>
    page(() =>
      __gimWorld.camera.three.getWorldDirection(__gimWorld.camera.three.position.clone()).toArray(),
    );
  const ready = async (kind) => {
    for (let i = 0; i < 600; i++) {
      const s = await status();
      if (s.mode === 'ready') {
        assert.equal(await page(() => __gimAppState.navigation.evidence().startKind), kind);
        return;
      }
      if (s.mode === 'preparing' && (await page(() => __gimAppState.navigation.pickingStart)))
        throw Error(s.message);
      await sleep(200);
    }
    throw Error('timed out preparing ' + kind);
  };
  const eye = () => page(() => __gimWorld.camera.three.position.toArray());
  const feet = () =>
    page(() => {
      const p = __gimWorld.camera.three.position
        .clone()
        .applyMatrix4(__gimAppState.projectCoordinateFrame.matrix.clone().invert());
      return [p.x, p.y, p.z - 1.68];
    });
  const mouse = (type, x, y, extra) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, ...extra });
  const click = async ([x, y]) => {
    await mouse('mousePressed', x, y, { button: 'left', clickCount: 1 });
    await mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 });
  };
  const key = (type, key, code) =>
    cdp.send('Input.dispatchKeyEvent', {
      type,
      key,
      code,
      windowsVirtualKeyCode: key === 'Escape' ? 27 : key.toUpperCase().charCodeAt(0),
    });
  const press = async (k, c) => {
    await key('keyDown', k, c);
    await key('keyUp', k, c);
  };
  const button = async (label) => {
    const point = await page((label) => {
      const button = [...document.querySelectorAll('button')].find(
        (b) =>
          b.getClientRects().length &&
          (b.getAttribute('aria-label') === label || b.textContent === label),
      );
      if (!button) return null;
      const r = button.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    }, label);
    assert.ok(point, 'missing control: ' + label);
    await click(point);
  };
  const center = () =>
    page(() => {
      const r = __gimWorld.renderer.three.domElement.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
  const selection = () => page(() => __gimAppState.selection.selectionRequest?.target ?? null);
  const candidates = await page((indoor) => {
    const w = __gimWorld,
      s = __gimAppState;
    if (indoor) {
      const p = w.camera.three.position
        .clone()
        .set(13.54, 39, -1.3333333)
        .applyMatrix4(s.projectCoordinateFrame.matrix);
      return [{ x: p.x, y: p.y, z: p.z, kind: 'reference-tread' }];
    }
    const list = [];
    for (const rt of s.ifc.regionalRuntimes.values())
      for (const o of rt.index.objects) {
        const road = /道路|地坪|场坪|路面|广场|地面/.test(o.name);
        if (!road && o.ifcType !== 'IFCSLAB') continue;
        const b = rt.worldBounds(o),
          p = b.getCenter(w.camera.three.position.clone());
        list.push({
          x: p.x,
          y: b.max.y,
          z: p.z,
          kind: o.ifcType,
          road,
          area: (b.max.x - b.min.x) * (b.max.z - b.min.z),
        });
      }
    return list.sort((a, b) => Number(b.road) - Number(a.road) || b.area - a.area).slice(0, 16);
  }, indoor);
  await button('进入巡视');
  await ready('gate');
  const initialOrbit = await eye();
  await button('开始巡视');
  await sleep(250);
  const gate = await page(() => __gimAppState.navigation.evidence().home);
  assert.ok(gate?.gate);
  result.gateFeet = await feet();
  assert.ok(distance(result.gateFeet, gate.feet) < 0.01);
  const gateView = await direction();
  result.gateDistance = await page(() => {
    const s = __gimAppState,
      w = __gimWorld,
      eye = w.camera.three.position.clone();
    let minimum = Infinity;
    for (const rt of s.ifc.regionalRuntimes.values())
      for (const o of rt.index.objects) {
        if (!/平开大门|推拉大门/.test(o.name) || /门杆|矩形柱/.test(o.name)) continue;
        const b = rt.worldBounds(o);
        if (b) {
          const p = eye.clone();
          p.y = Math.max(b.min.y, Math.min(b.max.y, p.y));
          minimum = Math.min(minimum, b.distanceToPoint(p));
        }
      }
    return Number.isFinite(minimum) ? minimum : null;
  });
  assert.ok(
    result.gateDistance !== null && result.gateDistance <= 11,
    'first entry is not near the source gate',
  );
  await press('Escape', 'Escape');
  await sleep(200);
  assert.equal((await status()).mode, 'paused');
  await button('退出巡视');
  await sleep(400);
  assert.equal((await status()).mode, 'orbit');
  assert.ok(distance(await eye(), initialOrbit) < 0.001);
  await button('进入巡视');
  await ready('last');
  await button('自选起点');
  result.entries = [];
  for (const candidate of candidates) {
    await page(
      async (o, indoor) => {
        const c = __gimWorld.camera.controls;
        await c.setLookAt(
          o.x - (indoor ? 0.12 : 0),
          o.y + (indoor ? 1.25 : 3),
          o.z + (indoor ? 0 : 0.06),
          o.x,
          o.y,
          o.z,
          false,
        );
        c.update(0);
      },
      candidate,
      indoor,
    );
    await sleep(300);
    await click(await center());
    let state;
    for (let i = 0; i < 450; i++) {
      await sleep(400);
      state = await status();
      if (state.mode === 'ready' || (i > 2 && !state.message.includes('正在准备'))) break;
    }
    result.entries.push({ candidate, state });
    if (state.mode === 'ready') break;
    if (state.message.includes('来源范围未知')) break;
  }
  assert.equal((await status()).mode, 'ready', 'no verified entry');
  const orbit = await eye(),
    original = await selection();
  const count = () => page(() => __gimAppState.viewerCommands.snapshot.distances.length);
  const originalCount = await count();
  await button('开始巡视');
  await sleep(300);
  const startFoot = await feet();
  result.walk = [];
  await key('keyDown', 'w', 'KeyW');
  try {
    for (let i = 0; i < 600; i++) {
      await sleep(250);
      const p = await feet();
      result.walk.push(p);
      if (indoor ? p[0] >= 17.65 : distance(p, startFoot) > 1.8) break;
      if (
        i > 8 &&
        result.walk.slice(-6).every((v) => distance(v, p) < 1e-6) &&
        !(await status()).message.includes('正在准备')
      )
        break;
    }
  } finally {
    await key('keyUp', 'w', 'KeyW');
  }
  const end = await feet();
  assert.ok(distance(startFoot, end) > 0.4, 'no walking displacement');
  if (indoor) {
    assert.ok(Math.abs(end[2]) < 0.035, 'did not reach upper landing');
    assert.ok(
      result.walk.some((p) => p[2] > -1.25 && p[2] < -0.2),
      'missing intermediate tread',
    );
    await key('keyDown', 's', 'KeyS');
    try {
      for (let i = 0; i < 200; i++) {
        await sleep(100);
        if ((await feet())[0] < 13.65) break;
      }
    } finally {
      await key('keyUp', 's', 'KeyS');
    }
    result.lowerTread = await feet();
    assert.ok(
      Math.abs(result.lowerTread[2] - startFoot[2]) < 0.04,
      'did not descend to the original tread',
    );
  }
  const evidence = () => page(() => __gimAppState.navigation.evidence());
  result.evidence = await evidence();
  result.stationaryDraws = [];
  let draws = result.evidence.drawCount;
  for (let i = 0; i < 18; i++) {
    await sleep(800);
    const current = (await evidence()).drawCount;
    result.stationaryDraws.push(current - draws);
    draws = current;
    if (i > 0 && result.stationaryDraws.slice(-2).every((v) => v === 0)) break;
  }
  assert.deepEqual(result.stationaryDraws.slice(-2), [0, 0], 'stationary view keeps drawing');
  const aim = await page((indoor) => {
    const state = __gimAppState,
      cam = __gimWorld.camera.three,
      inv = state.projectCoordinateFrame.matrix.clone().invert();
    const pos = cam.position.clone().applyMatrix4(inv),
      forward = cam.getWorldDirection(cam.position.clone()).transformDirection(inv);
    let target;
    if (indoor) {
      target = pos.clone();
      target.x += 0.1;
      target.z -= 1.68;
    } else {
      const nearest = [...state.deviceLodRuntime.rows.values()]
        .filter((r) => r.box && r.group?.visible)
        .map((r) => r.box.getCenter(cam.position.clone()))
        .sort((a, b) => a.distanceTo(cam.position) - b.distanceTo(cam.position))[0];
      if (!nearest) return null;
      target = nearest.applyMatrix4(inv);
    }
    const d = target.sub(pos).normalize(),
      diff = Math.atan2(d.x, d.y) - Math.atan2(forward.x, forward.y);
    const dx = Math.round(Math.atan2(Math.sin(diff), Math.cos(diff)) / 0.002),
      dy = Math.round((Math.asin(forward.z) - Math.asin(d.z)) / 0.002);
    const locked = document.pointerLockElement === __gimWorld.renderer.three.domElement;
    if (locked)
      document.dispatchEvent(
        new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true }),
      );
    return { dx, dy, locked };
  }, indoor);
  assert.ok(aim, 'no nearby displayed DEV target');
  const [cx, cy] = await center();
  if (!aim.locked) {
    let { dx, dy } = aim;
    while (dx || dy) {
      const x = Math.max(-65, Math.min(65, dx)),
        y = Math.max(-65, Math.min(65, dy));
      await mouse('mousePressed', cx, cy, { button: 'left', clickCount: 1 });
      await mouse('mouseMoved', cx + x, cy + y, { buttons: 1 });
      await mouse('mouseReleased', cx + x, cy + y, { button: 'left', clickCount: 1 });
      dx -= x;
      dy -= y;
    }
  }
  await sleep(350);
  await press('f', 'KeyF');
  await sleep(600);
  assert.equal((await status()).mode, 'inspecting');
  result.inspection = await page(() => ({
    kind: __gimAppState.selection.selectionRequest?.target?.kind,
    sources: __gimAppState.selection.engineeringSelection?.sourceIds.size,
    inspector: !!document.querySelector('#props-drawer-body')?.textContent.trim(),
  }));
  assert.ok(
    result.inspection.kind && result.inspection.sources > 0 && result.inspection.inspector,
    'inspection lacks an engineering source',
  );
  await button('两点测量');
  await sleep(180);
  await click([cx, cy]);
  await sleep(320);
  await click([cx + 4, cy]);
  await sleep(320);
  const measurement = await page(() => __gimAppState.viewerCommands.snapshot.distances.at(-1));
  assert.ok(
    (await count()) === originalCount + 1 &&
      measurement?.metres > 0 &&
      measurement.a.source &&
      measurement.b.source,
    'surface measurement missing',
  );
  result.measuredMetres = measurement.metres;
  await press('Escape', 'Escape');
  await sleep(200);
  assert.equal((await status()).mode, 'paused');
  assert.deepEqual(await selection(), original);
  const checkpoint = await feet(),
    look = await direction();
  await button('退出巡视');
  await sleep(400);
  assert.ok(distance(await eye(), orbit) < 0.001);
  await button('进入巡视');
  await ready('last');
  await button('开始巡视');
  await sleep(250);
  assert.ok(distance(await feet(), checkpoint) < 0.01, 're-entry lost the last walking position');
  assert.ok(distance(await direction(), look) < 0.001, 're-entry lost yaw or pitch');
  await press('Escape', 'Escape');
  await sleep(200);
  await button('返回大门');
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    if ((await status()).mode !== 'returning') break;
  }
  assert.ok(distance(await feet(), result.gateFeet) < 0.01, 'gate position not restored');
  assert.ok(distance(await direction(), gateView) < 0.001, 'gate direction not restored');
  await button('退出巡视');
  await sleep(400);
  assert.equal((await status()).mode, 'orbit');
  assert.ok(distance(await eye(), orbit) < 0.001, 'orbit position not restored');
  result.outcome = 'PASS';
  return { outcome: 'PASS' };
}

async function main() {
  if (process.env.CI) throw Error('Real patrol routes are local-only.');
  const manifest = arg('--build');
  if (!manifest) throw Error('Provide --build <native benchmark manifest>');
  const specs = JSON.parse(readFileSync(registry, 'utf8')).samples;
  const labels = arg('--sample') ? [arg('--sample')] : ['110-A2-1', '110-A3-1'];
  const dir = join(root, 'output', 'log', 'patrol-' + Date.now());
  mkdirSync(dir, { recursive: true });
  for (const label of labels) {
    assert.ok(Object.hasOwn(routes, label), 'unsupported sample label');
    const spec = specs.find((row) => row.path.includes(label + ' '));
    const sample = {
      sampleId: 'gim-' + spec.sourceSha256.slice(0, 16),
      sourceSha256: spec.sourceSha256,
      paths: [relative(root, resolve(dirname(registry), spec.path))],
    };
    const result = { label, sha: sample.sourceSha256, outcome: 'UNVERIFIED' };
    try {
      const run = await runNative({
        root,
        buildManifest: resolve(manifest),
        sample,
        timeoutMs: 240000,
        exercise: async ({ cdp }) => {
          try {
            return await exercise(cdp, routes[label] === 'stairs', result);
          } catch (error) {
            result.error = String(error);
            throw error;
          }
        },
      });
      result.run = run.out;
      assert.equal(result.outcome, 'PASS', result.error ?? 'native run did not finish the route');
    } catch (error) {
      result.outcome = 'FAIL';
      result.error ??= String(error);
      throw error;
    } finally {
      const dest = join(dir, label + '.json');
      writeFileSync(dest, JSON.stringify(result, null, 2));
      console.log(result.outcome, dest);
    }
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
