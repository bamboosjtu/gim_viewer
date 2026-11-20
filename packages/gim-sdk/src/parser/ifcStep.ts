/**
 * Generic IFC STEP lexical parser.
 *
 * This layer only recognizes entity boundaries, balanced parentheses and
 * quoted strings. IFC type semantics, spatial ownership and placement
 * interpretation stay in the desktop spatial builder.
 */

export interface RawIfcEntity {
  expressId: number;
  ifcType: string;
  args: string[];
}

export interface ScannedIfcEntity {
  expressId: number;
  ifcType: string;
  bodyStart: number;
  bodyEnd: number;
}

export type ScannedIfcEntityCallback = (
  expressId: number,
  ifcType: string,
  bodyStart: number,
  bodyEnd: number,
) => void;

/**
 * Scan STEP entity boundaries. Non-target entities only pay character-level
 * parenthesis/string scanning; no body substring or args array is allocated.
 */
export function scanIfcEntityBoundaries(
  text: string,
  onEntity: ScannedIfcEntityCallback,
): number {
  // IFC DATA records are delimited by `;` and their entity header is always
  // anchored at the beginning of a line/record. Let V8's native regexp engine
  // find the 6M headers first; only retained entities pay the nested-parenthesis
  // scan in materializeIfcEntity(). The character scanner below remains the
  // fallback for malformed/minified input where no anchored header is found.
  const header = /(?:^|;|\r?\n)\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  let fastCount = 0;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    fastCount++;
    onEntity(
      Number(match[1]),
      match[2].toUpperCase(),
      // The expression includes the opening parenthesis, so the body starts
      // at the match end. Avoid a second indexOf/lastIndexOf over all 6M
      // headers in large IFC files.
      match.index + match[0].length,
      // -1 means "resolve lazily". Retained records and placement-closure
      // records calculate their end only when their arguments are needed.
      -1,
    );
  }
  if (fastCount > 0) return fastCount;

  return scanIfcEntityBoundariesCharacter(text, onEntity);
}

/** Fallback for minimal STEP text without standard line/record separators. */
function scanIfcEntityBoundariesCharacter(
  text: string,
  onEntity: ScannedIfcEntityCallback,
): number {
  let count = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const hash = text.indexOf("#", cursor);
    if (hash < 0) break;
    let i = hash + 1;
    while (i < text.length && /\d/.test(text[i])) i++;
    if (i === hash + 1) {
      cursor = hash + 1;
      continue;
    }
    const expressId = Number(text.slice(hash + 1, i));
    while (/\s/.test(text[i] || "")) i++;
    if (text[i] !== "=") {
      cursor = i + 1;
      continue;
    }
    i++;
    while (/\s/.test(text[i] || "")) i++;
    const typeStart = i;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
    const ifcType = text.slice(typeStart, i).toUpperCase();
    while (/\s/.test(text[i] || "")) i++;
    if (!ifcType || text[i] !== "(") {
      cursor = i + 1;
      continue;
    }
    const bodyStart = ++i;
    let depth = 1;
    let inString = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'") {
        if (inString && text[i + 1] === "'") {
          i++;
          continue;
        }
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    count++;
    onEntity(expressId, ifcType, bodyStart, i);
    const semi = text.indexOf(";", i);
    cursor = semi >= 0 ? semi + 1 : i + 1;
  }
  return count;
}

export function materializeIfcEntity(
  text: string,
  entity: ScannedIfcEntity,
): RawIfcEntity {
  const bodyEnd =
    entity.bodyEnd >= entity.bodyStart
      ? entity.bodyEnd
      : findIfcEntityBodyEnd(text, entity.bodyStart - 1);
  if (bodyEnd < entity.bodyStart) {
    return { expressId: entity.expressId, ifcType: entity.ifcType, args: [] };
  }
  return {
    expressId: entity.expressId,
    ifcType: entity.ifcType,
    args: splitIfcArgs(text.slice(entity.bodyStart, bodyEnd)),
  };
}

function findIfcEntityBodyEnd(text: string, openParen: number): number {
  let depth = 1;
  let inString = false;
  for (let i = openParen + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      if (inString && text[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function splitIfcArgs(body: string): string[] {
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      if (inString && body[i + 1] === "'") {
        i++;
        continue;
      }
      inString = !inString;
    } else if (!inString) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        args.push(body.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  args.push(body.slice(start).trim());
  return args;
}
