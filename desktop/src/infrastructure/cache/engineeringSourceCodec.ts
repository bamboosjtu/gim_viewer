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

function sameReferences(row: readonly number[], previous: readonly (number | string)[]): boolean {
  if (row.length !== previous.length) return false;
  for (let i = 0; i < row.length; i++) if (row[i] !== previous[i]) return false;
  return true;
}

type PackedRow = PackedEngineeringSource['nodes'][number];

/** Build postordered IDs without retaining all serialized rows in the Worker. */
export function streamEngineeringSource(
  value: unknown,
  emit: (row: PackedRow) => void,
): Pick<PackedEngineeringSource, 'root' | 'shapes'> {
  return buildSourceTable(value, emit);
}

export function packEngineeringSource(value: unknown): PackedEngineeringSource {
  const nodes: PackedRow[] = [];
  const { shapes, root } = buildSourceTable(value, (row) => nodes.push(row), nodes);
  return { encoding: 'engineering-source-table-v1', shapes, nodes, root };
}

function buildSourceTable(
  value: unknown,
  emit: (row: PackedRow) => void,
  retainedNodes?: PackedRow[],
): Pick<PackedEngineeringSource, 'root' | 'shapes'> {
  const rowsById = retainedNodes ? undefined : new Map<number, number[]>();
  const rowAt = (id: number) => retainedNodes?.[id] ?? rowsById!.get(id)!;
  const shapes: string[][] = [];
  const texts = new Map<string, number>(),
    numbers = new Map<number, number>(),
    shapesByKey = new Map<string, number>();
  const objects = new WeakMap<object, number>(),
    active = new WeakSet<object>(),
    structures = new Map<number, number | number[]>();
  let nullId: number | undefined, trueId: number | undefined, falseId: number | undefined;
  let nextId = 0;
  const add = (row: PackedRow): number => {
    emit(row);
    return nextId++;
  };
  function visit(item: unknown): number {
    if (
      item == null ||
      typeof item === 'undefined' ||
      (typeof item === 'number' && !Number.isFinite(item))
    )
      return (nullId ??= add([0]));
    if (typeof item === 'string') {
      let id = texts.get(item);
      if (id === undefined) {
        id = add([1, item]);
        texts.set(item, id);
      }
      return id;
    }
    if (typeof item === 'number') {
      let id = numbers.get(item);
      if (id === undefined) {
        id = add([2, item]);
        numbers.set(item, id);
      }
      return id;
    }
    if (typeof item === 'boolean')
      return item ? (trueId ??= add([3, 1])) : (falseId ??= add([3, 0]));
    if (typeof item !== 'object') throw Error('Unsupported engineering source value');
    const prior = objects.get(item);
    if (prior !== undefined) return prior;
    if (active.has(item)) throw Error('Cyclic engineering source value');
    active.add(item);
    let row: number[];
    if (Array.isArray(item)) {
      row = [4];
      for (const child of item) row.push(visit(child));
    } else {
      const keys = Object.keys(item).filter(
          (key) => (item as Record<string, unknown>)[key] !== undefined,
        ),
        shapeKey = JSON.stringify(keys);
      let shape = shapesByKey.get(shapeKey);
      if (shape === undefined) {
        shape = shapes.length;
        shapes.push(keys);
        shapesByKey.set(shapeKey, shape);
      }
      row = [5, shape];
      for (const key of keys) row.push(visit((item as Record<string, unknown>)[key]));
    }
    // Keep the interning index numeric: a second textual copy of every
    // reference row dominates transient storage on large source graphs.
    let key = row.length;
    for (const reference of row) key = Math.imul(key ^ reference, 16777619);
    const previous = structures.get(key);
    let id =
      typeof previous === 'number'
        ? sameReferences(row, rowAt(previous))
          ? previous
          : undefined
        : previous?.find((candidate) => sameReferences(row, rowAt(candidate)));
    if (id === undefined) {
      id = add(row);
      // The streaming transport retains a bounded index of small reusable
      // rows. Object identities still share across the full result.
      if (!rowsById || (row.length <= 64 && rowsById.size < 65_536)) {
        rowsById?.set(id, row);
        if (Array.isArray(previous)) previous.push(id);
        else structures.set(key, previous === undefined ? id : [previous, id]);
      }
    }
    active.delete(item);
    objects.set(item, id);
    return id;
  }
  const root = visit(value);
  return { shapes, root };
}

function* unpackSourceNodes(
  shapes: unknown,
  root: unknown,
  pages: Iterable<unknown>,
  consume: boolean,
): Generator<void, unknown> {
  const fail = (): never => {
    throw Error('工程来源表编码无效');
  };
  if (!Array.isArray(shapes) || typeof root !== 'number' || !Number.isSafeInteger(root) || root < 0)
    return fail();
  for (const keys of shapes)
    if (
      !Array.isArray(keys) ||
      keys.some((key) => typeof key !== 'string') ||
      new Set(keys).size !== keys.length
    )
      return fail();
  const values: unknown[] = [];
  const objectEntries = new Array<Array<[string, unknown]> | undefined>(shapes.length);
  let i = 0;
  const reference = (id: unknown): unknown => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= i) return fail();
    return values[id];
  };
  for (const page of pages) {
    if (!Array.isArray(page)) return fail();
    for (let rowIndex = 0; rowIndex < page.length; rowIndex++, i++) {
      const row = page[rowIndex] as unknown[];
      if (!Array.isArray(row) || !row.length) return fail();
      switch (row[0]) {
        case 0:
          if (row.length !== 1) return fail();
          values.push(null);
          break;
        case 1:
          if (row.length !== 2 || typeof row[1] !== 'string') return fail();
          values.push(row[1]);
          break;
        case 2:
          if (row.length !== 2 || typeof row[1] !== 'number' || !Number.isFinite(row[1]))
            return fail();
          values.push(row[1]);
          break;
        case 3:
          if (row.length !== 2 || (row[1] !== 0 && row[1] !== 1)) return fail();
          values.push(row[1] === 1);
          break;
        case 4: {
          const result = new Array<unknown>(row.length - 1);
          for (let index = 1; index < row.length; index++)
            result[index - 1] = reference(row[index]);
          values.push(result);
          break;
        }
        case 5: {
          const shape = row[1];
          if (
            typeof shape !== 'number' ||
            !Number.isSafeInteger(shape) ||
            !shapes[shape] ||
            row.length !== (shapes[shape] as string[]).length + 2
          )
            return fail();
          const keys = shapes[shape] as string[];
          // Reuse the synchronous constructor's input, never its output. Native
          // construction keeps wide records compact and treats __proto__ as
          // data; per-shape pairs avoid per-record tuple arrays and closures.
          const entries = (objectEntries[shape] ??= keys.map((key): [string, unknown] => [
            key,
            undefined,
          ]));
          for (let index = 0; index < keys.length; index++)
            entries[index][1] = reference(row[index + 2]);
          values.push(Object.fromEntries(entries));
          break;
        }
        default:
          return fail();
      }
      if (consume) page[rowIndex] = null;
      if (i > 0 && i % 8192 === 0) yield;
    }
  }
  if (root >= values.length) return fail();
  return values[root];
}

/** Reconstruct postordered references across pages while discarding their raw rows. */
export async function unpackEngineeringSourcePages(
  shapes: unknown,
  root: unknown,
  pages: Iterable<unknown>,
  isCurrent: () => boolean,
  yieldToMain: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0)),
  consume = false,
): Promise<unknown> {
  const nodes = unpackSourceNodes(shapes, root, pages, consume);
  for (;;) {
    if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
    const next = nodes.next();
    if (next.done) return next.value;
    await yieldToMain();
  }
}

/** Hydration shares interned family facts and yields between bounded node
 * batches. A switched project never receives a partially decoded result. */
export async function unpackEngineeringSourceAsync(
  value: unknown,
  isCurrent: () => boolean,
  yieldToMain?: () => Promise<void>,
  consume = false,
): Promise<unknown> {
  if (!isCurrent()) throw new DOMException('Engineering hydration cancelled', 'AbortError');
  const packed = value as PackedEngineeringSource | undefined;
  if (
    packed?.encoding !== 'engineering-source-table-v1' ||
    !Array.isArray(packed.nodes) ||
    !Number.isSafeInteger(packed.root) ||
    packed.root >= packed.nodes.length
  )
    throw Error('工程来源表编码无效');
  return unpackEngineeringSourcePages(
    packed.shapes,
    packed.root,
    [packed.nodes],
    isCurrent,
    yieldToMain,
    consume,
  );
}
