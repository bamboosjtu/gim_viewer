import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedPaths } from './format-architecture.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const rustRoots = ['desktop/src-tauri', 'app/src-tauri', 'crates'];

export function changedRustSources(cwd, base) {
  return [...new Set(changedPaths(cwd, base, rustRoots))].filter((path) => path.endsWith('.rs'));
}

function run(command, args) {
  const child = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

function checkRust() {
  run('rustfmt', ['--version']);
  run('cargo', ['clippy', '--version']);
  const files = changedRustSources(root, process.env.GIM_FORMAT_BASE);
  if (files.length) {
    run('rustfmt', ['--edition', '2021', '--config', 'skip_children=true', '--check', ...files]);
  } else {
    console.log('No added or modified Rust sources in the selected Git range.');
  }
  const targets = [
    ['crates/gim-native-core/Cargo.toml', '--all-features'],
    ['desktop/src-tauri/Cargo.toml', '--all-features'],
    ['app/src-tauri/Cargo.toml', '--all-features'],
    ['app/src-tauri/Cargo.toml', '-p', 'tauri-plugin-gim-import'],
  ];
  for (const [manifest, ...selection] of targets) {
    run('cargo', [
      'clippy',
      '--manifest-path',
      manifest,
      ...selection,
      '--locked',
      '--all-targets',
      '--',
      '-D',
      'clippy::correctness',
      '-D',
      'clippy::suspicious',
      // Historical spacing stays visible in Clippy and is gated by rustfmt
      // as the affected files are changed.
      '-W',
      'clippy::empty_line_after_doc_comments',
      '-W',
      'clippy::empty_line_after_outer_attr',
    ]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) checkRust();
