/** Compact, lossless source facts. Reused DEV/FAM records can expand beyond
 * V8's single-string limit as flat JSON. Intern values and property shapes
 * before serializing; source identities and every original field remain data.
 * Nodes are postordered, so decoding cannot contain forward/cyclic references.
 */
export interface PackedEngineeringSource {
  encoding: 'engineering-source-table-v1';
  shapes: string[][];
  nodes: Array<Array<number | string>>;
  root: number;
}
export function packEngineeringSource(value: unknown): PackedEngineeringSource {
  const nodes: PackedEngineeringSource['nodes'] = [], shapes: string[][] = [];
  const texts = new Map<string, number>(), numbers = new Map<number, number>(), shapesByKey = new Map<string, number>();
  const objects = new WeakMap<object, number>(), active = new WeakSet<object>(), structures = new Map<string, number>();
  let nullId: number | undefined, trueId: number | undefined, falseId: number | undefined;
  const add = (node: Array<number | string>): number => { const id = nodes.length; nodes.push(node); return id; };
  function visit(item: unknown): number {
    if (item == null || typeof item === 'undefined' || typeof item === 'number' && !Number.isFinite(item)) return nullId ??= add([0]);
    if (typeof item === 'string') { let id = texts.get(item); if (id === undefined) { id = add([1, item]); texts.set(item, id); } return id; }
    if (typeof item === 'number') { let id = numbers.get(item); if (id === undefined) { id = add([2, item]); numbers.set(item, id); } return id; }
    if (typeof item === 'boolean') return item ? trueId ??= add([3, 1]) : falseId ??= add([3, 0]);
    if (typeof item !== 'object') throw Error('Unsupported engineering source value');
    const prior = objects.get(item); if (prior !== undefined) return prior;
    if (active.has(item)) throw Error('Cyclic engineering source value'); active.add(item);
    let row: number[];
    if (Array.isArray(item)) {
      row = [4]; for (const child of item) row.push(visit(child));
    } else {
      const keys = Object.keys(item).filter(key => (item as Record<string, unknown>)[key] !== undefined), shapeKey = JSON.stringify(keys);
      let shape = shapesByKey.get(shapeKey);
      if (shape === undefined) { shape = shapes.length; shapes.push(keys); shapesByKey.set(shapeKey, shape); }
      row = [5, shape]; for (const key of keys) row.push(visit((item as Record<string, unknown>)[key]));
    }
    // Equal immutable property rows are common even where the parser had to
    // create separate objects for references to the same source family.
    const key = row.join(','); let id = structures.get(key);
    if (id === undefined) { id = add(row); structures.set(key, id); }
    active.delete(item); objects.set(item, id); return id;
  }
  const root = visit(value); return { encoding: 'engineering-source-table-v1', shapes, nodes, root };
}

function* unpackSourceNodes(value: unknown,consume=false): Generator<void, unknown> {
  const fail = (): never => { throw Error('工程来源表编码无效'); };
  if (!value || typeof value !== 'object') return fail();
  const packed = value as PackedEngineeringSource;
  if (packed.encoding !== 'engineering-source-table-v1' || !Array.isArray(packed.shapes) || !Array.isArray(packed.nodes) || !Number.isSafeInteger(packed.root) || packed.root < 0 || packed.root >= packed.nodes.length) return fail();
  for (const keys of packed.shapes) if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) return fail();
  const values: unknown[] = [];
  const objectEntries:Array<Array<[string,unknown]>|undefined>=new Array(packed.shapes.length);
  let i=0;
  const reference = (id: number | string): unknown => { if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= i) return fail(); return values[id]; };
  for (; i < packed.nodes.length; i++) {
    const row = packed.nodes[i]; if (!Array.isArray(row) || !row.length) return fail();
    switch (row[0]) {
      case 0: if (row.length !== 1) return fail(); values.push(null); break;
      case 1: if (row.length !== 2 || typeof row[1] !== 'string') return fail(); values.push(row[1]); break;
      case 2: if (row.length !== 2 || typeof row[1] !== 'number' || !Number.isFinite(row[1])) return fail(); values.push(row[1]); break;
      case 3: if (row.length !== 2 || row[1] !== 0 && row[1] !== 1) return fail(); values.push(row[1] === 1); break;
      case 4: {
        const result=new Array<unknown>(row.length-1);
        for(let index=1;index<row.length;index++)result[index-1]=reference(row[index]);
        values.push(result);break;
      }
      case 5: {
        const shape = row[1]; if (typeof shape !== 'number' || !Number.isSafeInteger(shape) || !packed.shapes[shape] || row.length !== packed.shapes[shape].length + 2) return fail();
        const keys=packed.shapes[shape];
        // Reuse the synchronous constructor's input, never its output. Native
        // construction keeps wide records compact and treats __proto__ as
        // data; per-shape pairs avoid per-record tuple arrays and closures.
        const entries=objectEntries[shape]??=keys.map((key):[string,unknown]=>[key,undefined]);
        for(let index=0;index<keys.length;index++)entries[index][1]=reference(row[index+2]);
        values.push(Object.fromEntries(entries)); break;
      }
      default: return fail();
    }
    if(consume)(packed.nodes as unknown[])[i]=null;
    if (i > 0 && i % 8192 === 0) yield;
  }
  return values[packed.root];
}

export function unpackEngineeringSource(value: unknown): unknown {
  const nodes = unpackSourceNodes(value);
  for (;;) { const next = nodes.next(); if (next.done) return next.value; }
}

/** Hydration shares interned family facts and yields between bounded node
 * batches. A switched project never receives a partially decoded result. */
export async function unpackEngineeringSourceAsync(value: unknown, isCurrent: () => boolean,
  yieldToMain: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 0)),consume=false): Promise<unknown> {
  const nodes = unpackSourceNodes(value,consume);
  for (;;) {
    if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
    const next = nodes.next(); if (next.done) return next.value;
    await yieldToMain();
  }
}
