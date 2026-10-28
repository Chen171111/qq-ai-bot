"""固定时间戳 token 批量输出 —— 用于与 JS 移植版（vendor/js/ms-gec.mjs）逐位比对。

用法：
    python test_token_ticks.py <unix_ts1> <unix_ts2> ...
输出（每行）：
    <入参原文>\t<token>

验证方法：同一组时间戳分别喂给本脚本和 JS 版，逐行 diff。
任何一行不一致都说明移植有偏差，必须先修 JS 侧再上线。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from gen_token import load_drm


def main():
    drm = load_drm()
    for arg in sys.argv[1:]:
        ts = float(arg)
        print(f"{arg}\t{drm.generate_sec_ms_gec_v2(ts)}")


if __name__ == "__main__":
    main()
