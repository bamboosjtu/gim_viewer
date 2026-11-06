# -*- coding: utf-8 -*-
"""GIM 文件浏览器 —— 面向教程的文件指针浏览工具（默认入口）

模块划分（同目录平铺）：
  gim_reader.py   本文件：启动薄壳，仅做参数分发
  cli.py          命令行入口：--smoke 冒烟 / --guitest GUI 自检 / --legacy 旧界面
  ptr_kinds.py    指针类型谱系（4 组 9 种），分类唯一真源
  指针类型谱系.md 分类口径与实测对照
  gimbrowse.py    文件表 + 指针解析/类型标注 + 反向引用 + 引用链 + KV/XML/文本/二进制内容读取
  browse_gui.py   PySide6 界面：引用链树 / 四种内容视图 / 自动反向索引 / 跳转返回 / 链清单导出
  diag.py         诊断日志（%TEMP%/gim_reader.log）
  gim_gui.py / btv_*.py / dev_inst.py / gim_core.py …  旧版实体识别与融合树，仅 --legacy 使用

用法:
  GIM信息阅读器.exe                    # 打开 GUI，再选择解包后的 GIM 目录
  python gim_reader.py [目录]          # 直接打开指定目录
  python gim_reader.py --smoke 目录    # 无 Qt 冒烟：文件表 / 指针体检 / 引用链清单
  python gim_reader.py --guitest 目录  # 界面自检并截图 _browse.png / _chain_view.png / _xml_view.png
"""
from cli import main

if __name__ == '__main__':
    main()
