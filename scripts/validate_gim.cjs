#!/usr/bin/env node
/**
 * GIM 文件数据校验脚本
 *
 * 用法: node scripts/validate_gim.cjs <gim文件路径>
 * 示例: node scripts/validate_gim.cjs demo/demo-substation.gim
 *
 * 依赖: 7zip-min (devDependency, 自动安装 7z 二进制)
 *
 * 检查项目:
 *   1. GIM 文件头格式 (GIMPKGS + 压缩签名)
 *   2. 解压后目录结构 (CBM/ DEV/ PHM/ MOD/)
 *   3. CBM 层级完整性 (project.cbm 入口、递归引用无断链)
 *   4. CBM 引用的子文件是否存在 (SUBSYSTEM/SUBDEVICE)
 *   5. BASEFAMILY 引用的 FAM 文件是否存在
 *   6. OBJECTMODELPOINTER 引用的 DEV 文件是否存在
 *   7. IFCFILE 引用的 IFC 文件是否存在
 *   8. FileDevRelation.cbm 条目完整性 (DEV 引用是否存在)
 *   9. FileDevRelation 中 IFC 文件是否实际存在于 DEV/ 目录
 *  10. DEV/ 目录中的 IFC 文件是否被 CBM 或 FileDevRelation 引用
 *  11. CBM 中 IFCFILE+IFCGUID 配对完整性
 *  12. IFCGUID 格式校验 (22 位 Base64，可含尾部 $)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { unpack } = require('7zip-min');

// ── 工具函数 ──────────────────────────────────────────────

function parseKeyValue(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return result;
}

function findArchiveOffset(buffer) {
  const v = new Uint8Array(buffer);
  if (v.length < 8) return 0;
  if (String.fromCharCode(...v.slice(0, 7)) !== 'GIMPKGS') return 0;
  for (let i = 7; i < Math.min(v.length, 4096) - 5; i++) {
    if (v[i] === 0x37 && v[i+1] === 0x7a && v[i+2] === 0xbc && v[i+3] === 0xaf && v[i+4] === 0x27 && v[i+5] === 0x1c) return i;
  }
  for (let i = 7; i < Math.min(v.length, 4096) - 3; i++) {
    if (v[i] === 0x50 && v[i+1] === 0x4b && v[i+2] === 0x03 && v[i+3] === 0x04) return i;
  }
  return 0;
}

/** 将解压目录读取为 Map<path, content> */
function readExtractedDir(dirPath) {
  const files = new Map();
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        files.set(relPath, fullPath);
      }
    }
  }
  walk(dirPath);
  return files;
}

function readFileText(filePathMap, relPath) {
  const fullPath = filePathMap.get(relPath);
  if (!fullPath) return null;
  return fs.readFileSync(fullPath, 'utf-8');
}

// ── 校验逻辑 ──────────────────────────────────────────────

const issues = [];
const stats = { totalFiles: 0, cbmFiles: 0, devFiles: 0, famFiles: 0, ifcFiles: 0, phmFiles: 0, modFiles: 0, otherFiles: 0 };

function addIssue(severity, category, message) {
  issues.push({ severity, category, message });
}

async function validate(gimPath) {
  // ── 1. 文件存在性 ──
  if (!fs.existsSync(gimPath)) {
    addIssue('CRITICAL', '文件', `GIM 文件不存在: ${gimPath}`);
    printReport();
    return;
  }

  const stat = fs.statSync(gimPath);
  console.log(`文件: ${gimPath}`);
  console.log(`大小: ${(stat.size / 1024 / 1024).toFixed(2)} MB\n`);

  // ── 2. 读取并检测头部 ──
  const buf = fs.readFileSync(gimPath);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const offset = findArchiveOffset(arrayBuffer);

  if (offset === 0) {
    const v = new Uint8Array(arrayBuffer);
    const header = String.fromCharCode(...v.slice(0, Math.min(20, v.length)));
    if (header.startsWith('GIMPKGS')) {
      addIssue('CRITICAL', '头部', '检测到 GIMPKGS 头部但未找到 7z/ZIP 压缩签名');
    } else {
      addIssue('WARNING', '头部', `未检测到 GIMPKGS 头部，文件前 20 字节: ${header.replace(/[^\x20-\x7E]/g, '.')}`);
    }
    printReport();
    return;
  }

  const v = new Uint8Array(arrayBuffer);
  const is7z = v[offset] === 0x37;
  console.log(`头部: GIMPKGS, 压缩格式: ${is7z ? '7z' : 'ZIP'}, 数据偏移: ${offset}`);

  // ── 3. 提取压缩数据并解压 ──
  console.log('正在解压...');
  const tempDir = path.join(os.tmpdir(), `gim-validate-${Date.now()}`);
  const tempArchive = path.join(tempDir, 'archive.7z');
  fs.mkdirSync(tempDir, { recursive: true });

  // 提取压缩数据部分
  const compressedData = Buffer.from(arrayBuffer, offset);
  fs.writeFileSync(tempArchive, compressedData);

  try {
    await new Promise((resolve, reject) => {
      unpack(tempArchive, tempDir, (err) => err ? reject(err) : resolve());
    });
  } catch (err) {
    addIssue('CRITICAL', '解压', `解压失败: ${err.message}`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    printReport();
    return;
  }

  const files = readExtractedDir(tempDir);
  stats.totalFiles = files.size;
  console.log(`解压完成: ${files.size} 个文件\n`);

  // ── 4. 统计文件类型 ──
  const dirSet = new Set();
  for (const [p] of files) {
    const dir = p.split('/')[0];
    dirSet.add(dir);
    if (p.startsWith('CBM/') && p.endsWith('.cbm')) stats.cbmFiles++;
    else if (p.startsWith('DEV/') && p.endsWith('.dev')) stats.devFiles++;
    else if (p.startsWith('DEV/') && p.endsWith('.fam')) stats.famFiles++;
    else if (p.startsWith('DEV/') && p.endsWith('.ifc')) stats.ifcFiles++;
    else if (p.startsWith('PHM/') && p.endsWith('.phm')) stats.phmFiles++;
    else if (p.startsWith('MOD/')) stats.modFiles++;
    else stats.otherFiles++;
  }

  console.log('文件统计:');
  console.log(`  CBM: ${stats.cbmFiles}, DEV: ${stats.devFiles}, FAM: ${stats.famFiles}`);
  console.log(`  IFC: ${stats.ifcFiles}, PHM: ${stats.phmFiles}, MOD: ${stats.modFiles}, 其他: ${stats.otherFiles}`);
  console.log(`  目录: ${Array.from(dirSet).join(', ')}\n`);

  // ── 5. 目录结构检查 ──
  for (const dir of ['CBM', 'DEV']) {
    if (!dirSet.has(dir)) addIssue('ERROR', '目录结构', `缺少必需目录: ${dir}/`);
  }
  for (const dir of ['PHM', 'MOD']) {
    if (!dirSet.has(dir)) addIssue('INFO', '目录结构', `缺少可选目录: ${dir}/`);
  }

  // ── 6. CBM 层级完整性 ──
  console.log('正在检查 CBM 层级...');

  if (!files.has('CBM/project.cbm')) {
    addIssue('CRITICAL', 'CBM层级', '缺少工程入口文件 CBM/project.cbm');
  } else {
    const visited = new Set();

    async function walkCbm(cbmPath) {
      if (visited.has(cbmPath)) return;
      visited.add(cbmPath);

      const text = readFileText(files, cbmPath);
      if (text === null) { addIssue('ERROR', 'CBM层级', `CBM 文件不存在: ${cbmPath}`); return; }
      const kv = parseKeyValue(text);

      // SUBSYSTEM
      const sg = kv['SUBSYSTEM'];
      if (sg) {
        const child = `CBM/${sg}`;
        if (!files.has(child)) addIssue('ERROR', 'CBM引用', `${cbmPath}: SUBSYSTEM=${sg} → 文件不存在`);
        else await walkCbm(child);
      }

      // SUBSYSTEMS.NUM
      const sn = parseInt(kv['SUBSYSTEMS.NUM'] || '0', 10);
      for (let i = 0; i < sn; i++) {
        const s = kv[`SUBSYSTEM${i}`];
        if (s) {
          const child = `CBM/${s}`;
          if (!files.has(child)) addIssue('ERROR', 'CBM引用', `${cbmPath}: SUBSYSTEM${i}=${s} → 文件不存在`);
          else await walkCbm(child);
        } else addIssue('WARNING', 'CBM引用', `${cbmPath}: SUBSYSTEMS.NUM=${sn} 但 SUBSYSTEM${i} 为空`);
      }

      // SUBDEVICES.NUM
      const dn = parseInt(kv['SUBDEVICES.NUM'] || '0', 10);
      for (let i = 0; i < dn; i++) {
        const s = kv[`SUBDEVICE${i}`];
        if (s) {
          const child = `CBM/${s}`;
          if (!files.has(child)) addIssue('ERROR', 'CBM引用', `${cbmPath}: SUBDEVICE${i}=${s} → 文件不存在`);
          else await walkCbm(child);
        } else addIssue('WARNING', 'CBM引用', `${cbmPath}: SUBDEVICES.NUM=${dn} 但 SUBDEVICE${i} 为空`);
      }

      // BASEFAMILY
      const fam = kv['BASEFAMILY'];
      if (fam && !files.has(`CBM/${fam}`) && !files.has(`DEV/${fam}`))
        addIssue('ERROR', 'FAM引用', `${cbmPath}: BASEFAMILY=${fam} → 文件不存在`);

      // OBJECTMODELPOINTER
      const dev = kv['OBJECTMODELPOINTER'];
      if (dev && !files.has(`DEV/${dev}`))
        addIssue('ERROR', 'DEV引用', `${cbmPath}: OBJECTMODELPOINTER=${dev} → 文件不存在`);

      // IFCFILE
      const ifcFile = kv['IFCFILE'] || '';
      const ifcGuid = (kv['IFCGUID'] || '').replace(/\$+$/, '').trim();
      if (ifcFile && !files.has(`DEV/${ifcFile}`))
        addIssue('ERROR', 'IFC引用', `${cbmPath}: IFCFILE=${ifcFile} → 文件不存在`);

      // IFCGUID 格式 (IFC2X3 Base64: 22 位，$ 在 IFC2X3 中是合法字符可出现在任意位置)
      if (ifcGuid && !/^[0-9A-Za-z_$]{21,22}$/.test(ifcGuid))
        addIssue('WARNING', 'IFCGUID格式', `${cbmPath}: IFCGUID="${ifcGuid}" 格式异常 (期望 21-22 位 Base64)`);

      // IFCFILE / IFCGUID 配对
      if (ifcFile && !ifcGuid) addIssue('INFO', 'IFC关联', `${cbmPath}: IFCFILE="${ifcFile}" 非空但 IFCGUID 为空`);
      if (!ifcFile && ifcGuid) addIssue('WARNING', 'IFC关联', `${cbmPath}: IFCGUID="${ifcGuid}" 非空但 IFCFILE 为空`);
    }

    await walkCbm('CBM/project.cbm');

    // 孤立 CBM 文件
    let orphanCount = 0;
    for (const [p] of files) {
      if (p.startsWith('CBM/') && p.endsWith('.cbm') && p !== 'CBM/project.cbm' && p !== 'CBM/FileDevRelation.cbm' && !visited.has(p))
        orphanCount++;
    }
    if (orphanCount > 0)
      addIssue('INFO', 'CBM层级', `CBM 目录有 ${orphanCount} 个 .cbm 文件未被 project.cbm 层级树引用 (可能被 FileDevRelation 引用)`);

    console.log(`  CBM 层级节点: ${visited.size}, 孤立文件: ${orphanCount}\n`);
  }

  // ── 7. FileDevRelation.cbm 检查 ──
  console.log('正在检查 FileDevRelation...');

  if (!files.has('CBM/FileDevRelation.cbm')) {
    addIssue('WARNING', 'FileDevRelation', '缺少 CBM/FileDevRelation.cbm');
  } else {
    const text = readFileText(files, 'CBM/FileDevRelation.cbm');
    const kv = parseKeyValue(text);
    const num = parseInt(kv['FILE.NUM'] || '0', 10);
    console.log(`  FILE.NUM=${num} (${num / 2} 个 IFC 文件)\n`);

    const ifcFilesInRelation = new Set();
    const devicesInRelation = new Set();

    for (let i = 0; i < num; i += 2) {
      const ifcName = kv[`FILE${i}.NAME`] || '';
      const devNum = parseInt(kv[`FILE${i}.DEV.NUM`] || '0', 10);
      const ifcFile = kv[`FILE${i + 1}.IFC`] || `${ifcName}.ifc`;

      ifcFilesInRelation.add(ifcFile);
      if (!files.has(`DEV/${ifcFile}`))
        addIssue('ERROR', 'FileDevRelation', `FILE${i} (${ifcName}): IFC 文件 ${ifcFile} 不存在于 DEV/ 目录`);

      let missingDevs = 0;
      for (let j = 0; j < devNum; j++) {
        const dev = kv[`FILE${i}.DEV${j}`];
        if (dev) {
          devicesInRelation.add(dev);
          if (!files.has(`CBM/${dev}`)) missingDevs++;
        }
      }
      if (missingDevs > 0)
        addIssue('ERROR', 'FileDevRelation', `FILE${i} (${ifcName}): ${missingDevs}/${devNum} 个设备 CBM 文件不存在`);

      let actualDevs = 0;
      for (let j = 0; j < devNum; j++) if (kv[`FILE${i}.DEV${j}`]) actualDevs++;
      if (actualDevs !== devNum)
        addIssue('WARNING', 'FileDevRelation', `FILE${i} (${ifcName}): DEV.NUM=${devNum} 但实际只有 ${actualDevs} 个 DEV 条目`);
    }

    console.log(`  IFC 文件: ${ifcFilesInRelation.size}, 设备: ${devicesInRelation.size}\n`);

    // ── 8. DEV/ 目录 IFC 文件覆盖率 ──
    console.log('正在检查 IFC 文件引用覆盖率...');
    const ifcFilesInDev = new Set();
    for (const [p] of files) {
      if (p.startsWith('DEV/') && p.toLowerCase().endsWith('.ifc'))
        ifcFilesInDev.add(p.split('/').pop());
    }

    let unreferencedIfc = 0;
    for (const ifcFile of ifcFilesInDev) {
      if (!ifcFilesInRelation.has(ifcFile)) {
        unreferencedIfc++;
        addIssue('WARNING', 'IFC覆盖率', `DEV/${ifcFile} 未被 FileDevRelation 引用`);
      }
    }
    console.log(`  DEV/ 目录 IFC 文件: ${ifcFilesInDev.size}, 未被引用: ${unreferencedIfc}\n`);

    // ── 9. FileDevRelation 设备不在 CBM 树中的统计 ──
    console.log('正在检查设备覆盖率...');
    const allCbmFiles = new Set();
    for (const [p] of files) {
      if (p.startsWith('CBM/') && p.endsWith('.cbm')) allCbmFiles.add(p.split('/').pop());
    }
    let devNotInCbm = 0;
    for (const dev of devicesInRelation) {
      if (!allCbmFiles.has(dev)) devNotInCbm++;
    }
    if (devNotInCbm > 0)
      addIssue('WARNING', '设备覆盖率', `FileDevRelation 中 ${devNotInCbm}/${devicesInRelation.size} 个设备 CBM 文件在 CBM/ 目录中不存在`);
    console.log(`  设备总数: ${devicesInRelation.size}, CBM 目录缺失: ${devNotInCbm}\n`);
  }

  // ── 10. IFC 关联统计 ──
  console.log('正在检查 IFC 关联完整性...');
  let ifcGuidNoFile = 0, ifcFileNoGuid = 0, bothPresent = 0;
  for (const [p] of files) {
    if (!p.startsWith('CBM/') || !p.endsWith('.cbm')) continue;
    const text = readFileText(files, p);
    if (!text) continue;
    const kv = parseKeyValue(text);
    const ifcFile = kv['IFCFILE'] || '';
    const ifcGuid = (kv['IFCGUID'] || '').replace(/\$+$/, '').trim();
    if (ifcFile && ifcGuid) bothPresent++;
    else if (ifcFile && !ifcGuid) ifcFileNoGuid++;
    else if (!ifcFile && ifcGuid) ifcGuidNoFile++;
  }
  console.log(`  IFCFILE+IFCGUID 均非空: ${bothPresent}, 仅 IFCFILE: ${ifcFileNoGuid}, 仅 IFCGUID: ${ifcGuidNoFile}\n`);

  if (ifcFileNoGuid > 0)
    addIssue('INFO', 'IFC关联', `${ifcFileNoGuid} 个 CBM 节点有 IFCFILE 但无 IFCGUID (无法精确定位 IFC 构件)`);

  // ── 清理临时目录 ──
  fs.rmSync(tempDir, { recursive: true, force: true });

  // ── 11. 汇总报告 ──
  printReport();
}

function printReport() {
  const severityCount = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
  for (const issue of issues) severityCount[issue.severity]++;

  console.log('════════════════════════════════════════');
  console.log('校验报告');
  console.log('════════════════════════════════════════');
  console.log(`严重 (CRITICAL): ${severityCount.CRITICAL}`);
  console.log(`错误 (ERROR):    ${severityCount.ERROR}`);
  console.log(`警告 (WARNING):  ${severityCount.WARNING}`);
  console.log(`信息 (INFO):     ${severityCount.INFO}`);
  console.log(`总计:            ${issues.length}`);
  console.log('');

  if (issues.length > 0) {
    const order = ['CRITICAL', 'ERROR', 'WARNING', 'INFO'];
    for (const sev of order) {
      const sevIssues = issues.filter(i => i.severity === sev);
      if (sevIssues.length === 0) continue;
      console.log(`── ${sev} ──────────────────────────────`);
      let lastCat = '';
      for (const issue of sevIssues) {
        if (issue.category !== lastCat) { console.log(`[${issue.category}]`); lastCat = issue.category; }
        console.log(`  ${issue.message}`);
      }
      console.log('');
    }
  } else {
    console.log('未发现数据缺陷\n');
  }

  if (severityCount.CRITICAL > 0 || severityCount.ERROR > 0) process.exit(1);
}

// ── 入口 ──────────────────────────────────────────────────

const gimPath = process.argv[2];
if (!gimPath) {
  console.error('用法: node scripts/validate_gim.cjs <gim文件路径>');
  console.error('示例: node scripts/validate_gim.cjs demo/demo-substation.gim');
  process.exit(1);
}

validate(gimPath).catch(err => {
  console.error('校验过程中出错:', err);
  process.exit(1);
});
