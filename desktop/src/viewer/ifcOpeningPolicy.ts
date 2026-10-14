/** Operates on an owned Worker input. STEP IDs and byte offsets stay stable.
 * Quoted strings and comments are never interpreted as records. Source disk
 * bytes remain intact; only geometry's derived input loses opening relations. */
export function omitIfcOpeningRelations(
  bytes: Uint8Array,
  retainRelation: (id: number) => boolean = () => false,
  onRelation?: (relation: { id: number; host: number; opening: number }) => void
): number {
  let start = -1,
    quoted = false,
    comment = false,
    removed = 0;
  const whitespace = (v: number) => v === 32 || v === 9 || v === 10 || v === 13;
  const name = 'IFCRELVOIDSELEMENT';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i],
      next = bytes[i + 1];
    if (comment) {
      if (c === 42 && next === 47) {
        comment = false;
        i++;
      }
      continue;
    }
    if (quoted) {
      if (c === 39) {
        if (next === 39) i++;
        else quoted = false;
      }
      continue;
    }
    if (c === 47 && next === 42) {
      comment = true;
      i++;
      continue;
    }
    if (c === 39) {
      quoted = true;
      continue;
    }
    if (c === 35 && start < 0) start = i;
    if (c !== 59) continue;
    if (start >= 0) {
      let p = start + 1;
      while (bytes[p] >= 48 && bytes[p] <= 57) p++;
      while (whitespace(bytes[p])) p++;
      if (bytes[p++] === 61) {
        while (whitespace(bytes[p])) p++;
        let match = true;
        for (let k = 0; k < name.length; k++)
          if ((bytes[p + k] & 223) !== name.charCodeAt(k)) {
            match = false;
            break;
          }
        p += name.length;
        while (whitespace(bytes[p])) p++;
        if (match && bytes[p] === 40) {
          const id = Number(
            new TextDecoder()
              .decode(bytes.subarray(start + 1, bytes.indexOf(61, start)))
              .trim()
          );
          if (onRelation) {
            // References in quoted text/comments are not relation endpoints.
            let quote = false,
              block = false,
              depth = 0,
              field = 0;
            const refs = new Map<number, number>();
            for (let k = p + 1; k < i; k++) {
              const c = bytes[k],
                n = bytes[k + 1];
              if (block) {
                if (c === 42 && n === 47) {
                  block = false;
                  k++;
                }
                continue;
              }
              if (quote) {
                if (c === 39) {
                  if (n === 39) k++;
                  else quote = false;
                }
                continue;
              }
              if (c === 47 && n === 42) {
                block = true;
                k++;
                continue;
              }
              if (c === 39) {
                quote = true;
                continue;
              }
              if (c === 40) {
                depth++;
                continue;
              }
              if (c === 41) {
                depth--;
                continue;
              }
              if (c === 44 && depth === 0) {
                field++;
                continue;
              }
              if (c === 35 && depth === 0) {
                let end = k + 1;
                while (bytes[end] >= 48 && bytes[end] <= 57) end++;
                refs.set(
                  field,
                  Number(new TextDecoder().decode(bytes.subarray(k + 1, end)))
                );
                k = end - 1;
              }
            }
            const host = refs.get(4),
              opening = refs.get(5);
            if (field !== 5 || !host || !opening)
              throw Error(`Invalid IFC opening relation #${id}`);
            onRelation({ id, host, opening });
          }
          if (retainRelation(id)) {
            start = -1;
            continue;
          }
          for (let k = start; k <= i; k++)
            if (bytes[k] !== 10 && bytes[k] !== 13) bytes[k] = 32;
          removed++;
        }
      }
    }
    start = -1;
  }
  return removed;
}
