export interface SearchItem {
  /** 唯一键（通常为节点路径），onPick 回传 */
  key: string;
  /** 主标题 */
  title: string;
  /** 副标题（可选，如实体类型 / 塔位编号） */
  subtitle?: string;
  /** 已转为小写的检索全文；内部来源名称可参与检索，无需堆在副标题中。 */
  searchText?: string;
}
