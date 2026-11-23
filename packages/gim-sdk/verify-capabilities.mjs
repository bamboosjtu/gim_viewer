import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
const capabilities = [
  "parser",
  "source",
  "semantic",
  "geometry",
  "engineering",
  "projection",
  "source-adapter",
];

// Directory ownership decides a module's role; every input path must resolve
// through these prefixes and unknown paths fail closed.
function capabilityPath(input) {
  const path = input.replaceAll("\\", "/");
  const sdk = path.lastIndexOf("/gim-sdk/src/");
  if (sdk >= 0) return "src/" + path.slice(sdk + "/gim-sdk/src/".length);
  return path;
}

function inputRole(input) {
  const path = capabilityPath(input);
  if (path.startsWith("src/parser/")) return "parser";
  if (path.startsWith("src/source/")) return "source";
  if (path.startsWith("src/semantic/catalog/")) return "directory";
  if (path.startsWith("src/semantic/")) return "semantic";
  if (path.startsWith("src/geometry/")) return "geometry";
  if (path.startsWith("src/engineering/")) return "engineering";
  if (path.startsWith("src/projection/")) return "projection";
  if (path.startsWith("src/adapters/")) return "source-adapter";
  if (path.startsWith("src/shared/")) return "shared";
  if (/(?:^|\/)gim-primitives\/src\//.test(path)) return "format";
  // Unknown src/ directories are not silently reinterpreted as format.
  return undefined;
}

const allowed = {
  parser: ["parser", "format", "shared"],
  source: ["parser", "source", "format", "shared"],
  semantic: ["semantic", "directory", "shared"],
  // Geometry has always consumed the shared source-document readers; the tree
  // migration renames their role from 'format' to 'source', so the allowance
  // follows the files instead of inventing a new violation.
  geometry: ["geometry", "parser", "source", "format", "shared"],
  engineering: ["engineering", "geometry", "shared"],
  projection: ["projection", "directory", "shared"],
  "source-adapter": [
    "source-adapter",
    "parser",
    "source",
    "format",
    "shared",
    "semantic",
    "directory",
  ],
};

// Engineering consumes the semantic snapshot as a type-only fusion input.
// Runtime imports remain forbidden; the exception is deliberately type-only.
const typeAllowed = {
  engineering: [...allowed.engineering, "semantic"],
  projection: [...allowed.projection, "parser", "source", "format", "semantic"],
};

export function assertCapabilityInputs(capability, inputs, kind = "runtime") {
  const permitted =
    (kind === "type"
      ? (typeAllowed[capability] ?? allowed[capability])
      : allowed[capability]) ?? [];
  const forbidden = inputs.filter(
    (input) => !permitted.includes(inputRole(input)),
  );
  if (forbidden.length)
    throw Error(
      `${capability} ${kind} closure imports ${forbidden.join(", ")}`,
    );
}

function typeClosure(entry) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    customConditions: ["gim-source"],
    allowImportingTsExtensions: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const program = ts.createProgram([resolve(root, entry)], options);
  return program
    .getSourceFiles()
    .map((file) => file.fileName.replaceAll("\\", "/"))
    .filter((file) =>
      /\/(?:gim-sdk|gim-primitives|contracts-native|powerline-core)\/src\//.test(
        file,
      ),
    )
    .map((file) => {
      const sdk = file.lastIndexOf("/gim-sdk/src/");
      if (sdk >= 0) return "src/" + file.slice(sdk + "/gim-sdk/src/".length);
      return file;
    });
}

export async function verifyCapabilities() {
  return Object.fromEntries(
    await Promise.all(
      capabilities.map(async (capability) => {
        const entry = manifest.exports["./" + capability]["gim-source"];
        const result = await build({
          absWorkingDir: root,
          entryPoints: [entry],
          bundle: true,
          write: false,
          metafile: true,
          format: "esm",
          platform: "neutral",
        });
        const inputs = Object.keys(result.metafile.inputs);
        assertCapabilityInputs(capability, inputs, "runtime");
        const types = typeClosure(entry);
        assertCapabilityInputs(capability, types, "type");
        return [
          capability,
          {
            inputs: inputs.length,
            bytes: result.outputFiles[0].contents.length,
            typeInputs: types.length,
          },
        ];
      }),
    ),
  );
}
