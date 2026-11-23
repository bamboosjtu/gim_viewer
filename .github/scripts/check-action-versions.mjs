import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requiredWorkflows = new Set([
  "android-ci.yml",
  "tools-gim-blender.yml",
  "tools-gim-device.yml",
  "tools-gim-element.yml",
  "tools-gim-info.yml",
  "windows-ci.yml",
]);
const usesKey = /^\s*(?:-\s*)?(?:"uses"|'uses'|uses)\s*:\s*(.*)$/;
const usesValue = /^(?:"([^"]+)"|'([^']+)'|([^\s#]+))(?:\s+#.*)?\s*$/;
const flowUsesKey = /^[^#]*[{,]\s*(?:"uses"|'uses'|uses)\s*:/;

export function checkActionVersions(policy, workflows) {
  const failures = [];
  for (const workflow of workflows.keys()) {
    if (!requiredWorkflows.has(workflow)) {
      failures.push(`unexpected workflow: ${workflow}`);
    }
  }
  for (const workflow of requiredWorkflows) {
    if (!workflows.has(workflow))
      failures.push(`required workflow is missing: ${workflow}`);
  }
  for (const [action, version] of Object.entries(policy.actions)) {
    const firstParty = action.startsWith("actions/");
    const refFormat = firstParty ? /^v\d+$/ : /^[a-f0-9]{40}$/;
    if (typeof version !== "string" || !refFormat.test(version)) {
      const expected = firstParty
        ? "a major tag (vN)"
        : "a full 40-character commit SHA";
      failures.push(
        `.github/action-versions.json: ${action} requires ${expected}`,
      );
    }
  }
  const seen = new Set();
  for (const [workflow, content] of workflows) {
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const location = `${workflow}:${index + 1}`;
      const match = line.match(usesKey);
      if (!match) {
        if (flowUsesKey.test(line))
          failures.push(
            `${location}: use a standalone uses: entry so its pin can be checked`,
          );
        continue;
      }
      const value = match[1].match(usesValue);
      const reference = value && (value[1] ?? value[2] ?? value[3]);
      if (!reference) {
        failures.push(`${location}: uses: requires a literal action reference`);
        continue;
      }
      if (reference.startsWith("./") || reference.startsWith("docker://"))
        continue;
      const at = reference.lastIndexOf("@");
      if (at <= 0 || at === reference.length - 1) {
        failures.push(
          `${location}: action reference must include a version: ${reference}`,
        );
        continue;
      }
      const action = reference.slice(0, at);
      const version = reference.slice(at + 1);
      if (!Object.hasOwn(policy.actions, action)) {
        failures.push(
          `${location}: action is not in .github/action-versions.json: ${action}`,
        );
        continue;
      }
      seen.add(action);
      const expected = policy.actions[action];
      if (version !== expected)
        failures.push(
          `${location}: ${action}@${version} does not match policy ${expected}`,
        );
    }
  }
  for (const action of Object.keys(policy.actions)) {
    if (!seen.has(action))
      failures.push(`policy action is never used: ${action}`);
  }
  return failures;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.cwd();
  const policy = JSON.parse(
    readFileSync(join(root, ".github/action-versions.json"), "utf8"),
  );
  const directory = join(root, ".github/workflows");
  const workflows = new Map(
    readdirSync(directory)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort()
      .map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
  const failures = checkActionVersions(policy, workflows);
  if (failures.length) {
    console.error("GitHub Action pin check failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `GitHub Action pins match policy across ${workflows.size} workflows.`,
    );
  }
}
