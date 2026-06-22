import { describe, expect, it } from 'vitest';
import { parseSld } from '../sldParser.js';

const SAMPLE_SLD = `<?xml version="1.0" encoding="utf-8"?>
<svg version="DLT1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="351.2542" height="182.5214" viewBox="0, 0, 351.2542, 182.5214" reversion="2023" soft="GRevitTools">
  <defs>
    <script type="text/css"><![CDATA[.主接线连接线层 {fill:none;stroke:rgb(0,191,255);stroke-width:1}.主接线母线层 {fill:none;stroke:rgb(0,255,0);stroke-width:2}]]></script>
    <symbol id="3606819c-73e0-4eeb-b75e-2521aae566e2" xOffset="-0.003" yOffset="-1.734E-18">
      <circle cx="1" cy="0" r="0.25" id="T1" stroke-width="1" type="terminal" />
      <line x1="0" y1="0" x2="2" y2="6" stroke-width="1" />
    </symbol>
    <symbol id="6c197121-7e8f-4a08-80b6-755023186a5d">
      <circle cx="1" cy="1" r="0.25" id="T1" />
    </symbol>
  </defs>
  <g id="BackGround_Layer" type="Drawing">
    <line x1="0" y1="0" x2="100" y2="100" />
  </g>
  <g gridId="A0AEC*002" type="Bay">
    <use xlink:href="#3606819c-73e0-4eeb-b75e-2521aae566e2" x="100" y="50" />
    <use xlink:href="#6c197121-7e8f-4a08-80b6-755023186a5d" x="200" y="60" />
    <g gridId="A0AEC*002GSK*010" type="Group">
      <use xlink:href="#3606819c-73e0-4eeb-b75e-2521aae566e2" x="300" y="70" />
    </g>
  </g>
  <g gridId="A0ATA*240GFA*001" type="ConductingEquipment">
    <use xlink:href="#6c197121-7e8f-4a08-80b6-755023186a5d" x="400" y="80" />
  </g>
</svg>`;

describe('parseSld', () => {
  it('解析 demo 样本：DLT1/2023 版本', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.version).toBe('DLT1');
    expect(doc.soft).toBe('GRevitTools');
    expect(doc.revision).toBe('2023');
  });

  it('解析 width/height/viewBox', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.width).toBeCloseTo(351.2542, 4);
    expect(doc.height).toBeCloseTo(182.5214, 4);
    expect(doc.viewBox).toEqual([0, 0, 351.2542, 182.5214]);
  });

  it('抽出 CSS 内容并删除原始 <script> 块', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.css).toContain('.主接线连接线层');
    expect(doc.css).toContain('.主接线母线层');
    // safeSvgOuterHTML 不应包含 <script type="text/css">
    expect(doc.safeSvgOuterHTML).not.toContain('<script type="text/css">');
  });

  it('收集 symbol 定义（id → outerHTML）', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.symbols.size).toBe(2);
    expect(doc.symbols.has('3606819c-73e0-4eeb-b75e-2521aae566e2')).toBe(true);
    expect(doc.symbols.has('6c197121-7e8f-4a08-80b6-755023186a5d')).toBe(true);
    // outerHTML 应包含 <symbol
    const symHtml = doc.symbols.get('3606819c-73e0-4eeb-b75e-2521aae566e2')!;
    expect(symHtml).toContain('<symbol');
    expect(symHtml).toContain('circle');
  });

  it('解析顶层 <g> 节点列表', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.groups).toHaveLength(3); // BackGround_Layer + Bay + ConductingEquipment
    expect(doc.groups[0].id).toBe('BackGround_Layer');
    expect(doc.groups[0].type).toBe('Drawing');
    expect(doc.groups[1].gridId).toBe('A0AEC*002');
    expect(doc.groups[1].type).toBe('Bay');
  });

  it('解析 <use> 元素（含 x/y 坐标和 symbolId）', () => {
    const doc = parseSld(SAMPLE_SLD);
    const bay = doc.groups[1];
    expect(bay.uses).toHaveLength(2);
    expect(bay.uses[0].symbolId).toBe('3606819c-73e0-4eeb-b75e-2521aae566e2');
    expect(bay.uses[0].x).toBe(100);
    expect(bay.uses[0].y).toBe(50);
    expect(bay.uses[1].symbolId).toBe('6c197121-7e8f-4a08-80b6-755023186a5d');
    expect(bay.uses[1].x).toBe(200);
  });

  it('解析嵌套 <g>（subGroups）', () => {
    const doc = parseSld(SAMPLE_SLD);
    const bay = doc.groups[1];
    expect(bay.subGroups).toHaveLength(1);
    expect(bay.subGroups[0].gridId).toBe('A0AEC*002GSK*010');
    expect(bay.subGroups[0].type).toBe('Group');
  });

  it('构建 gridId 索引（仅含非空 gridId）', () => {
    const doc = parseSld(SAMPLE_SLD);
    expect(doc.gridIdIndex.size).toBe(3); // Bay + Group + ConductingEquipment
    expect(doc.gridIdIndex.has('A0AEC*002')).toBe(true);
    expect(doc.gridIdIndex.has('A0AEC*002GSK*010')).toBe(true);
    expect(doc.gridIdIndex.has('A0ATA*240GFA*001')).toBe(true);
  });

  it('空文本返回空文档', () => {
    const doc = parseSld('');
    expect(doc.version).toBe('');
    expect(doc.groups).toHaveLength(0);
    expect(doc.symbols.size).toBe(0);
  });

  it('非 SVG 文本返回空文档', () => {
    const doc = parseSld('not svg');
    expect(doc.version).toBe('');
  });

  it('viewBox 用逗号分隔也能解析', () => {
    const doc = parseSld('<svg viewBox="0,0,100,200"/>');
    expect(doc.viewBox).toEqual([0, 0, 100, 200]);
  });

  it('无 defs 时返回空 symbols 和空 css', () => {
    const doc = parseSld('<svg><g id="test"/></svg>');
    expect(doc.css).toBe('');
    expect(doc.symbols.size).toBe(0);
  });

  it('revision 字段优先取 reversion', () => {
    const doc = parseSld('<svg reversion="2023"/>');
    expect(doc.revision).toBe('2023');
  });

  it('revision 字段回退到 revision', () => {
    const doc = parseSld('<svg revision="2024"/>');
    expect(doc.revision).toBe('2024');
  });
});

describe('parseSld 安全净化（P0 评审）', () => {
  it('移除无 type 的 <script>（默认 JS）且其内容不进入 CSS', () => {
    const doc = parseSld(`<svg xmlns="http://www.w3.org/2000/svg"><defs><script>alert(1)</script></defs><g/></svg>`);
    expect(doc.css).not.toContain('alert');
    expect(doc.safeSvgOuterHTML).not.toContain('<script');
    expect(doc.safeSvgOuterHTML).not.toContain('alert');
  });

  it('剔除 on* 事件属性', () => {
    const doc = parseSld(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><g onclick="alert(2)" id="x"/></svg>`);
    expect(doc.safeSvgOuterHTML).not.toContain('onload');
    expect(doc.safeSvgOuterHTML).not.toContain('onclick');
    expect(doc.safeSvgOuterHTML).toContain('id="x"');
  });

  it('删除 foreignObject / <style> 等非白名单元素', () => {
    const doc = parseSld(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body>pwn</body></foreignObject>` +
      `<style>.a{fill:red}</style><rect width="1" height="1"/></svg>`,
    );
    expect(doc.safeSvgOuterHTML).not.toContain('foreignObject');
    expect(doc.safeSvgOuterHTML).not.toContain('<style');
    expect(doc.safeSvgOuterHTML).not.toContain('pwn');
    expect(doc.safeSvgOuterHTML).toContain('<rect');
  });

  it('use 的外部引用被剔除，本地 # 引用保留', () => {
    const doc = parseSld(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      `<defs><symbol id="s1"/></defs>` +
      `<use xlink:href="#s1"/><use xlink:href="https://evil.example/x.svg"/><use xlink:href="javascript:alert(1)"/></svg>`,
    );
    expect(doc.safeSvgOuterHTML).toContain('#s1');
    expect(doc.safeSvgOuterHTML).not.toContain('evil.example');
    expect(doc.safeSvgOuterHTML).not.toContain('javascript');
  });

  it('CSS 净化：url()/@import/expression 被剥离', () => {
    const doc = parseSld(
      `<svg xmlns="http://www.w3.org/2000/svg"><defs><script type="text/css">` +
      `.a{fill:none;stroke:url(https://evil.example/ping);}` +
      `@import "https://evil.example/x.css";` +
      `.b{width:expression(alert(1));}</script></defs><g/></svg>`,
    );
    expect(doc.css).not.toContain('url(');
    expect(doc.css).not.toContain('@import');
    expect(doc.css).not.toContain('expression');
    expect(doc.css).toContain('.a');
  });

  it('属性值中的 javascript: 协议被剔除', () => {
    const doc = parseSld(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="javascript:alert(1)"/></svg>`,
    );
    expect(doc.safeSvgOuterHTML).not.toContain('javascript');
  });
});
