"""剧本/分镜组领域层（FastAPI-Only 迁移第三阶段第三组）。

从 Node ``server/services/frame-character-consistency.mjs``、
``server/services/voice-profiles.mjs`` 等文件逐行为复刻的纯函数域模块，
不访问数据库/网络，供路由层与测试复用。
"""
