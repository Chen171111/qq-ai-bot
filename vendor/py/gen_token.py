"""
单独加载 edge_tts 的 drm.py，生成 Sec-MS-GEC token。

为什么单独做这个：
  edge_tts 整个包依赖 aiohttp（装不上，沙箱拦 pip 的 .metadata 写入）。
  但 generate_sec_ms_gec_v2() 是纯标准库实现（hashlib/struct/email.utils），
  aiohttp 只在 handle_client_response_error()（时钟校准分支）里用到。
  所以直接用 importlib 加载 drm.py 这一个文件，绕开整个包的依赖树。

用法：
  python gen_token.py            → 输出当前 token
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DRM_PATH = os.path.join(HERE, "edge_tts", "drm.py")


def load_drm():
    spec = importlib.util.spec_from_file_location("edge_tts_drm", DRM_PATH)
    mod = importlib.util.module_from_spec(spec)
    # drm.py 顶部有 `from .constants import ...` 和 `from .exceptions import ...`
    # 是相对导入，单独加载会失败。用桩模块顶替这两个。
    sys.modules["edge_tts_drm"] = mod

    import types

    pkg = types.ModuleType("edge_tts_pkg")
    pkg.__path__ = [HERE]
    sys.modules["edge_tts_pkg"] = pkg

    const = types.ModuleType("edge_tts_pkg.constants")
    const.TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"
    const.BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud"
    const.WSS_URL = f"wss://{const.BASE_URL}/edge/v1?TrustedClientToken={const.TRUSTED_CLIENT_TOKEN}"
    const.VOICE_LIST = f"https://{const.BASE_URL}/voices/list?trustedclienttoken={const.TRUSTED_CLIENT_TOKEN}"
    const.DEFAULT_VOICE = "en-US-EmmaMultilingualNeural"
    const.CHROMIUM_FULL_VERSION = "143.0.3650.75"
    const.CHROMIUM_MAJOR_VERSION = const.CHROMIUM_FULL_VERSION.split(".")[0]
    const.SEC_MS_GEC_VERSION = f"2-{const.CHROMIUM_FULL_VERSION}"
    const.BASE_HEADERS = {}
    const.WSS_HEADERS = {}
    const.VOICE_HEADERS = {}
    const.TICKS_PER_SECOND = 10_000_000
    const.MP3_BITRATE_BPS = 48_000
    sys.modules["edge_tts_pkg.constants"] = const

    exc = types.ModuleType("edge_tts_pkg.exceptions")

    class SkewAdjustmentError(Exception):
        pass

    exc.SkewAdjustmentError = SkewAdjustmentError
    sys.modules["edge_tts_pkg.exceptions"] = exc

    # 把 drm.py 里的相对导入指向桩包
    src = open(DRM_PATH, encoding="utf-8").read()
    src = src.replace("from .constants import", "from edge_tts_pkg.constants import")
    src = src.replace("from .exceptions import", "from edge_tts_pkg.exceptions import")
    src = src.replace("import aiohttp", "aiohttp = None  # 桩：只在时钟校准分支用到")

    exec(compile(src, DRM_PATH, "exec"), mod.__dict__)
    return mod


def main():
    drm = load_drm()
    token = drm.generate_sec_ms_gec_v2()
    print(token)


if __name__ == "__main__":
    main()
