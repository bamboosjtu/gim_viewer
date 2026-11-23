import { expect, it, vi } from 'vitest';
import { AppState } from '../../../app/state.js';
import { buildCbmTree } from '../../../gim/cbmParser.js';
import { deviceTemplateCacheKey } from '../../../infrastructure/cache/devLodIdentity.js';
import { writeDevArtifact } from '@desktop/devLodCache.js';
import { DESKTOP_COMMANDS } from '@desktop/contracts.js';
import { readNodeDevGlb } from '../nodeGeometrySources.js';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@desktop/runtime.js', () => ({ isTauri: () => true }));
vi.mock('../../../infrastructure/native/invokeTimed.js', () => ({ invokeTimed: invoke }));

it('reads the published L0 artifact from the same source-bound store on node selection', async () => {
  const sha = 'a'.repeat(64);
  const state = new AppState();
  const session = state.activateProject(4, sha);
  const path = 'DEV/device.dev';
  state.currentFiles = new Map([
    ['CBM/project.cbm', new File(['ENTITYNAME=F1System\nSUBSYSTEM=asset.cbm'], 'project.cbm')],
    ['CBM/asset.cbm', new File(['ENTITYNAME=F4System\nOBJECTMODELPOINTER=device.dev'], 'asset.cbm')],
    [path, new File(['SYMBOLNAME=device'], 'device.dev')],
  ]);
  const root = await buildCbmTree(state.currentFiles);
  const node = root!.children[0]!;
  const bytes = Uint8Array.of(0x67, 0x6c, 0x54, 0x46);
  let stored: { entry: string; bytes: Uint8Array } | undefined;
  invoke.mockImplementation(async (command: string, input: unknown) => {
    if (command === DESKTOP_COMMANDS.write_device_lod_artifact) {
      const packet = input as Uint8Array;
      const head = new DataView(packet.buffer).getUint32(5, true) + 9;
      const meta = JSON.parse(new TextDecoder().decode(packet.subarray(9, head)));
      expect(meta).toMatchObject({ project_id: 4, source_gim_sha256: sha });
      stored = { entry: meta.entry_path, bytes: packet.slice(head) };
      return {};
    }
    expect(command).toBe(DESKTOP_COMMANDS.read_device_lod_artifacts);
    expect(input).toMatchObject({
      projectId: 4, sourceGimSha256: sha, entryPaths: [stored!.entry],
    });
    const encoded = new TextEncoder().encode(stored!.entry);
    const response = new Uint8Array(57 + 4 + encoded.length + 9 + stored!.bytes.length);
    const view = new DataView(response.buffer);
    response.set([0x47, 0x49, 0x4d, 0x52, 1]);
    view.setUint32(5, 1, true);
    view.setBigUint64(41, BigInt(stored!.bytes.length), true);
    view.setUint32(49, 1, true);
    view.setUint32(57, encoded.length, true);
    response.set(encoded, 61);
    const flag = 61 + encoded.length;
    response[flag] = 1;
    view.setBigUint64(flag + 1, BigInt(stored!.bytes.length), true);
    response.set(stored!.bytes, flag + 9);
    return response.buffer;
  });
  const key = deviceTemplateCacheKey(sha, path, 0);
  const published = await writeDevArtifact('templates', key, {
    result: {
      bytes,
      status: 'partial',
      diagnostics: { status: 'partial', reason: 'missing-dependency' },
    },
  }, session);
  expect(published).toBe(true);
  expect(await readNodeDevGlb(node, state, session)).toMatchObject({
    path, bytes, diagnostic: { status: 'partial', source: 'warm', reason: 'missing-dependency' },
  });
  state.activateProject(5, 'b'.repeat(64));
  expect(await readNodeDevGlb(node, state, session)).toBeUndefined();
  expect(invoke).toHaveBeenCalledTimes(2);
});
