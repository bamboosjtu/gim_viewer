import type { RawPrimitiveSource } from "../parser/rawXmlMod.js";
import { xmlModNumber } from "../parser/xmlModValues.js";
import type { GeometryDiagnostic } from "./primitiveContracts.js";

/** Registered case spellings are resolved here; raw values remain on the source declaration. */
export class StandardFields {
  readonly diagnostics: GeometryDiagnostic[] = [];
  constructor(readonly source: RawPrimitiveSource) {}
  fail(field: string, message: string) {
    this.diagnostics.push({
      code: "invalid-field-value",
      severity: "error",
      stage: "interpret",
      message,
      location: { field, sourceTag: this.source.sourceTag },
    });
  }
  get(field: string) {
    return (
      this.source.rawAttributes[field] ??
      this.source.rawAttributes[field.toUpperCase()]
    );
  }
  number(field: string, positive = true, defaultValue?: number): number {
    const text = this.get(field);
    if (text === undefined && defaultValue !== undefined) return defaultValue;
    const v = xmlModNumber(text);
    if (!Number.isFinite(v) || (positive && v <= 0))
      this.fail(field, `Invalid numeric field ${field}`);
    return v;
  }
  integer(field: string, defaultValue?: number): number {
    const v = this.number(field, true, defaultValue);
    if (!Number.isSafeInteger(v)) this.fail(field, "Expected an integer");
    return v;
  }
  angle(field: string, full = true) {
    const v = this.number(field, true, full ? 2 * Math.PI : undefined);
    if (v > 2 * Math.PI || (!full && v === 2 * Math.PI))
      this.fail(field, "Angle exceeds its sweep domain");
    return v;
  }
}
