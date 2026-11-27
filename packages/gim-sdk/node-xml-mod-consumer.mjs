/** Test-host adapter. The installed SDK receives nodes, not an XML library. */
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parseXmlModRoot } from "@gim/gim-sdk/parser";

const reader = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
});

function elements(rows) {
  return rows.flatMap((row) => {
    const tagName = Object.keys(row).find(
      (key) => key !== ":@" && !key.startsWith("#") && !key.startsWith("?"),
    );
    return tagName
      ? [{ tagName, attrs: row[":@"] ?? {}, children: elements(row[tagName]) }]
      : [];
  });
}

export function readXmlMod(text, context = {}) {
  function reject(code, message) {
    throw Object.assign(new Error(message), {
      code,
      stage: "parse",
      severity: "error",
      location: { path: context?.sourcePath },
    });
  }
  if (
    !["project-column-major", "a3-21-example"].includes(context?.matrixLayout)
  ) {
    reject("matrix-layout-required", "Specify the source matrix layout");
  }
  if (/<!DOCTYPE\b/i.test(text))
    reject("invalid-xml", "DOCTYPE is unsupported");
  const valid = XMLValidator.validate(text);
  if (valid !== true) reject("invalid-xml", valid.err.msg);
  const roots = elements(reader.parse(text));
  if (roots.length !== 1)
    reject("invalid-xml", "Expected one document element");
  return parseXmlModRoot(roots[0], context);
}
