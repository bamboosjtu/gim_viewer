/** Project vocabulary for construction/operation browsing; not a national code list. */
export const ENGINEERING_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  E01: '主变压器', E02: '高压并联电抗器', E03: '站用变压器', E04: '消弧线圈、小电阻及接地变成套装置',
  E05: '组合电器', E06: '断路器', E07: '隔离开关', E08: '接地开关', E09: '开关柜', E10: '并联电容器成套装置',
  E11: '低压并联电抗器', E12: '静止无功发生器', E13: '电流互感器', E14: '电压互感器', E15: '避雷器',
  E16: '二次设备', 'E16.terminal_box': '端子箱', 'E16.control': '控制柜', 'E16.protection': '保护设备',
  E17: '动力辅助设备', E18: '预制舱开关设备', E19: '水工暖通设备', 'E-T': '变压器（用途待确认）',
  M01: '导线', M02: '母线', M03: '金具', M04: '绝缘子', M05: '电缆', M06: '接地材料', M07: '套管与槽盒',
  'C-A1': '墙', 'C-A2': '楼板', 'C-A3': '柱', 'C-A4': '梁', 'C-A5': '板件', 'C-A6': '屋面构件',
  'C-A7': '门', 'C-A8': '窗', 'C-A9': '楼梯与栏杆', 'C-A10': '建筑面层',
  'C-B1': '设备支架', 'C-B2': '基础', 'C-B3': '型钢与钢板', 'C-B4': '檩条', 'C-B5': '构架与桁架',
  'C-C1': '电缆沟构件', 'C-C2': '排水沟构件', 'C-C3': '井池构件', 'C-C4': '围墙与围栏构件', 'C-C5': '道路与地坪构件',
  'C-D1': '照明设施', 'C-D2': '消防报警设施', 'C-D3': '视频与门禁设施', 'C-D4': '暖通给排水管件', 'C-D5': '其他附属设施',
  'U-OBJECT': '待识别对象',
};
export const categoryLabel = (code: string) => ENGINEERING_CATEGORY_LABELS[code] ?? code;
