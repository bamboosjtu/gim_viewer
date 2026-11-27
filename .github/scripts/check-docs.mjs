import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const files = execFileSync(
  "git",
  ["ls-files", "-z", "README.md", "AGENTS.md", "docs/**/*.md", "docs/*.md"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
const errors = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence) continue;
    for (const match of line.matchAll(
      /\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g,
    )) {
      const ref = (match[1] ?? match[2]).split("#")[0];
      if (!ref || /^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
      if (!existsSync(resolve(dirname(file), decodeURIComponent(ref))))
        errors.push(`${file}:${i + 1} missing ${ref}`);
    }
    if (
      line.startsWith("|") &&
      lines[i + 1]?.trim() === "" &&
      lines[i + 2]?.startsWith("|") &&
      !/^\|[\s:|-]+\|$/.test(lines[i + 3] ?? "")
    )
      errors.push(`${file}:${i + 2} interrupted table`);
  }
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    `Checked local links and tables in ${files.length} tracked documents.`,
  );
