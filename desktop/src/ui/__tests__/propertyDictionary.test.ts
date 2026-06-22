import { describe, expect, it } from 'vitest';
import {
  fileReferenceValue,
  fileReferencesValue,
  getPropertyDefinition,
  getPropertyLabel,
  getPropertyReferenceKind,
  renderPropertyRows,
  renderTechnicalSection,
} from '../propertyDictionary.js';

describe('属性字典与引用展示', () => {
  it('组件字典为常见索引键提供中文标签', () => {
    expect(getPropertyLabel('substation-cbm', 'BASEFAMILY1')).toBe('属性族引用');
    expect(getPropertyLabel('substation-dev', 'SOLIDMODEL0')).toBe('组合模型引用');
    expect(getPropertyLabel('line-node', 'STRING2.STRING')).toBe('导线串引用');
    expect(getPropertyDefinition('ifc-object', 'GlobalId')?.priority).toBe(2);
    expect(getPropertyLabel('substation-fam', '额定电压')).toBe('额定电压');
  });

  it('文件引用只输出可读按钮，不泄露 GUID 文件名', () => {
    const path = 'DEV/7f1c9aa0-3d6b-4f6d-8c7d-device.dev';
    const value = fileReferenceValue('dev', path);
    expect(value.text).toBe('查看 DEV');
    expect(value.html).toContain('class="prop-ref-link"');
    const visible = value.html.replace(/\sdata-reference-path="[^"]*"/g, '');
    expect(visible).not.toContain(path);
    expect(visible).not.toContain('7f1c9aa0');
    expect(value.html).toContain('data-reference-path=');
  });

  it('自动识别 BASEFAMILY/OBJECTMODELPOINTER 与扩展名引用', () => {
    expect(getPropertyReferenceKind('substation-dev', 'BASEFAMILY', 'abc.fam')).toBe('fam');
    expect(getPropertyReferenceKind('substation-cbm', 'OBJECTMODELPOINTER', 'abc.dev')).toBe('dev');
    expect(getPropertyReferenceKind('line-node', 'STRING0.STRING', 'abc.cbm')).toBe('cbm');
    expect(getPropertyReferenceKind('line-node', 'IFCGUID', '3f7e-guid-like-value')).toBeUndefined();
  });

  it('引用属性行渲染为按钮，未知字段进入技术字段折叠区', () => {
    const html = renderPropertyRows('substation-dev', [
      { key: 'BASEFAMILY', value: 'abc.fam' },
    ]);
    expect(html).toContain('属性族引用');
    expect(html).toContain('查看属性族');
    expect(html.replace(/\sdata-reference-path="[^"]*"/g, '')).not.toContain('abc.fam');

    const technical = renderTechnicalSection('DEV 技术字段', 'substation-dev', [
      { key: 'VENDOR_PRIVATE_TOKEN', value: 'opaque-value' },
    ]);
    expect(technical).toContain('<details');
    expect(technical).toContain('VENDOR_PRIVATE_TOKEN');
    expect(technical).toContain('opaque-value');
  });

  it('多文件引用保持可读按钮并隐藏所有原始路径', () => {
    const first = 'MOD/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.mod';
    const second = 'MOD/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.mod';
    const value = fileReferencesValue('mod', [first, second]);
    expect(value.text).toBe('查看来源 1、查看来源 2');
    expect(value.html).toContain('查看来源 1');
    expect(value.html).toContain('查看来源 2');
    const visible = value.html.replace(/\sdata-reference-path="[^"]*"/g, '');
    expect(visible).not.toContain(first);
    expect(visible).not.toContain(second);
  });

  it('BLHA/POINT 坐标在属性值中逐行展示', () => {
    const html = renderPropertyRows('line-node', [
      { key: 'BLHA', value: '26.85118440,112.43051833,65.210,313.737688' },
      { key: 'POINT0.BLHA', value: '26.85118440,112.43051833,65.210,313.737688' },
    ]);
    expect(html).toContain('prop-coordinate');
    expect(html).toContain('纬度 26.85118440 °');
    expect(html).toContain('经度 112.43051833 °');
    expect(html).toContain('起点纬度 26.85118440 °');
    expect(html).toContain('高程 65.210 m');
    expect(html).not.toContain('26.85118440,112.43051833,65.210,313.737688</td>');
  });
});
