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
  // Collect literal spans with V8's native regexp engine, then find headers.
  // The span list is small for normal IFC (hundreds to a few hundred thousand)
  // and avoids a JS callback for every quote. A malformed unclosed literal
  // falls back to the stateful scanner below.
  // High string density (property-heavy products) makes a span array large;
  // The 1000/300k threshold is a shape fence, not a correctness condition.
  // sample three regions so clustered strings late in the file are still found.
  const sampleSize = 300_000;
  const maxOffset = Math.max(0, text.length - sampleSize);
  const literalPattern = /'(?:''|[^'])*'|"(?:[^"]*)"|\/\*[\s\S]*?\*\//g;
  if (
    [0, Math.floor(maxOffset / 2), maxOffset].some(
      (offset) =>
        (text.slice(offset, offset + sampleSize).match(literalPattern)
          ?.length ?? 0) > 1000,
    )
  )
    return scanIfcEntityBoundariesStateful(text, onEntity);

  const spans: Array<[number, number]> = [];
  // The trailing alternatives catch an unclosed quote/comment; complete
  // literals are matched first so their contents are not scanned twice.
  const literals = /'(?:''|[^'])*'|"(?:[^"]*)"|\/\*[\s\S]*?\*\/|['"]|\/\*/g;
  let literal: RegExpExecArray | null;
  while ((literal = literals.exec(text)) !== null) {
    if (literal[0] === "'" || literal[0] === '"' || literal[0] === "/*")
      return scanIfcEntityBoundariesStateful(text, onEntity);
    spans.push([literal.index, literal.index + literal[0].length]);
  }

  const header = /(?:^|;|\*\/|\r?\n)\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;
  let count = 0;
  let span = 0;
  let match: RegExpExecArray | null;
  while ((match = header.exec(text)) !== null) {
    // Spans only need checking while the next candidate can overlap this
    // header. Avoid a per-header `lastIndexOf` once all literals are behind.
    if (
      span < spans.length &&
      spans[span][0] <= match.index + match[0].length
    ) {
      // The regexp may include a leading `;`, newline or comment terminator;
      // validate the `#` position, not the delimiter position.
      const headerIndex = match.index + match[0].lastIndexOf("#");
      while (span < spans.length && spans[span][1] <= headerIndex) span++;
      if (span < spans.length && spans[span][0] <= headerIndex) continue;
    }
    onEntity(Number(match[1]), match[2].toUpperCase(), header.lastIndex, -1);
    count++;
  }
  if (count > 0) return count;
  return scanIfcEntityBoundariesCharacter(text, onEntity);
}

/** Stateful fallback for malformed/unclosed literals. */
function scanIfcEntityBoundariesStateful(
  text: string,
  onEntity: ScannedIfcEntityCallback,
): number {
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

/** Fallback for malformed/minified text where the header regexp finds nothing. */
function scanIfcEntityBoundariesCharacter(
  text: string,
  onEntity: ScannedIfcEntityCallback,
): number {
  let cursor = 0;
  let count = 0;
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
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || (ch === "/" && text[i + 1] === "*")) {
        i = skipStepLiteral(text, i) - 1;
        continue;
      }
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
