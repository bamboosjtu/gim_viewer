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
 * Scan only entity starts. Argument slices and nested parentheses remain lazy
 * so skipped records do not allocate an argument array.
 */
export function scanIfcEntityBoundaries(
  text: string,
  onEntity: ScannedIfcEntityCallback,
): number {
  // Assignments identify entity headers outside strings and comments. A
  // comment is legal whitespace, including between a delimiter and a header.
  const tokens = /\/\*|['"]|#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(text)) !== null) {
    if (match[1] === undefined) {
      tokens.lastIndex = skipStepLiteral(text, match.index);
      continue;
    }
    onEntity(Number(match[1]), match[2].toUpperCase(), tokens.lastIndex, -1);
    count++;
  }
  return count;
}

/** Return the next offset after a quoted value or block comment. */
function skipStepLiteral(text: string, start: number): number {
  if (text[start] === "/") {
    const end = text.indexOf("*/", start + 2);
    return end < 0 ? text.length : end + 2;
  }
  const quote = text[start];
  let end = text.indexOf(quote, start + 1);
  while (end >= 0 && quote === "'" && text[end + 1] === "'") {
    end = text.indexOf(quote, end + 2);
  }
  return end < 0 ? text.length : end + 1;
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
  for (let i = openParen + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || (ch === "/" && text[i + 1] === "*")) {
      i = skipStepLiteral(text, i) - 1;
      continue;
    }
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
  let depth = 0;
  let contentStart = 0;
  let content = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" || ch === '"') {
      i = skipStepLiteral(body, i) - 1;
    } else if (ch === "/" && body[i + 1] === "*") {
      content += body.slice(contentStart, i) + " ";
      i = skipStepLiteral(body, i) - 1;
      contentStart = i + 1;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      args.push((content + body.slice(contentStart, i)).trim());
      contentStart = i + 1;
      content = "";
    }
  }
  args.push((content + body.slice(contentStart)).trim());
  return args;
}
