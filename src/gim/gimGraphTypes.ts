/**
 * 通用线路图结构类型定义。
 *
 * 与变电工程的 CbmNode 不同，GimGraph 统一覆盖线路工程的所有引用类型：
 * CBM/DEV/FAM/PHM/MOD/STL/WIRE/IFC，并保留 rawRefs 用于后续三维渲染挂点。
 *
 * 依据 docs/gim_line.md：线路工程无 IFC，使用 Cbm/Dev/Mod/Phm 目录。
 */

import type { GimProjectType } from './projectType.js';

/** 线路图节点：对应一个 CBM 文件，递归引用子节点 */
export interface GimGraphNode {
  /** 节点对应文件路径，如 Cbm/xxx.cbm */
  path: string;
  /** 节点显示名称（默认取 BASEFAMILY 同名或文件名，UI 可覆盖） */
  name: string;
  /** 实体类型（ENTITYNAME），如 F1System/F2System/F3System/F4System/Tower_Device/Wire_Device/WIRE/CROSS */
  entityName: string;
  /** 分类名称（GROUPTYPE / WIRETYPE / DEVICETYPE 等业务分类，用于图标和分组） */
  classifyName: string;
  /** 原始键值对（parseKeyValue 解析结果，保留 POINT<i>.BLHA / KVALUE / SPLIT 等） */
  rawProps: Record<string, string>;
  /** 子节点（递归构建） */
  children: GimGraphNode[];
  /** 引用清单（按文件类型归类，值为文件相对名如 xxx.dev） */
  refs: {
    cbmFiles: string[];
    devFiles: string[];
    famFiles: string[];
    phmFiles: string[];
    modFiles: string[];
    stlFiles: string[];
    wireFiles: string[];
    ifcFiles: string[];
    /** 原始引用键 → 引用值列表（保留 STRING<i>.GPOINT 等非文件挂点信息） */
    rawRefs: Record<string, string[]>;
  };
}

/** 整体图结构 */
export interface GimGraph {
  /** 工程类型 */
  projectType: GimProjectType;
  /** 根节点（通常对应 Cbm/project.cbm 的 SUBSYSTEM 指向的 F1System） */
  root: GimGraphNode | null;
  /** 路径 → 节点 索引（便于点击 3D 构件反查节点） */
  nodesByPath: Map<string, GimGraphNode>;
  /** 按扩展名归类的全部文件路径清单 */
  filesByType: {
    cbm: string[];
    dev: string[];
    fam: string[];
    phm: string[];
    mod: string[];
    stl: string[];
    ifc: string[];
    other: string[];
  };
  /** 统计信息：节点总数 / F1-F4 数量 / 各实体类型数量 / MOD/STL 数量 */
  stats: Record<string, number>;
}
