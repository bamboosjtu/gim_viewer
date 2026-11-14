"""Display labels and ordering only; recognition lives in standard_recognition."""
import re
ST_OK,ST_CAND,ST_UNC='已确认','候选','未确认'
E16_LABEL={'terminal_box':'端子箱','battery_set':'蓄电池组','control_cabinet':'控制柜','panel_cabinet':'屏柜'}
E16_SEQ={code:i for i,code in enumerate(E16_LABEL)}
def dev_sub_label(code):return E16_LABEL.get(code,code or '')
_NUM_CODE=re.compile(r'^([EM])(\d+)$')
_CON_CODE=re.compile(r'^C-([A-Z])(\d+)$')
OTH_SEQ={c:i for i,c in enumerate(('U-SPACE','U-TYPE','U-SIZE','U-PORT','U-NONAME','U-EXCL','U-INTERNAL','U-PENDING','U-ORG'))}

def order_key(code):
    """目录编码排序键——界面与报告一律按目录顺序，不按数量。

    设备 E01→E19 → E-T（用途待确认）→ U-*；材料 M01→M07；
    构件 C-A1→C-A10 → C-B1… → C-D6 → 未细分；
    其他 U-SPACE…U-ORG → 未识别（U-OBJECT）殿后。
    """
    c = (code or '').strip().upper()
    m = _NUM_CODE.match(c)
    if m:
        return (0, 0 if m.group(1) == 'E' else 1, int(m.group(2)), 0)
    if c == 'E-T':
        return (0, 2, 0, 0)
    m = _CON_CODE.match(c)
    if m:
        return (1, ord(m.group(1)) - ord('A'), int(m.group(2)), 0)
    if c in OTH_SEQ:
        return (2, OTH_SEQ[c], 0, 0)
    return (9, 0, 0, 0)
