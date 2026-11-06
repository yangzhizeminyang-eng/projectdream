"""分镜质量分析试点包。

包含三部分：
- :mod:`.rules`：Node ``quality-gate.mjs`` 三个质检函数的 Python 精确复刻（纯函数）；
- :mod:`.fixtures`：Node ``quality-gate.test.mjs`` 测试样例的结构化转译；
- :mod:`.graph`：LangGraph 编排图（规则门禁 + 可选模型复核）。
"""

from .rules import (
    inspect_generated_video_result,
    inspect_storyboard_asset_reference_gate,
    inspect_storyboard_generation_context,
)

__all__ = [
    "inspect_generated_video_result",
    "inspect_storyboard_asset_reference_gate",
    "inspect_storyboard_generation_context",
]
