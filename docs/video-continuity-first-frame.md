# 视频首帧连续性验收

连续镜头生成时，上一镜已采用视频的精确末帧由 Worker 抽取为 YUV420P TIFF，并以稳定对象键保存。下一镜提交时，Worker 将该帧作为 Wan `first_frame` 输入；供应商生成完成后，再从对象存储按键读取同一 TIFF，在候选视频入库前替换解码第 0 帧。

FFmpeg 对修正版的第 0 帧和参考 TIFF 统一解码为 YUV420P 并计算 `framemd5`。哈希一致后才允许保存视频与新末帧；尺寸不一致、参考对象缺失、媒体处理失败或哈希不一致都会拒绝候选入库。处理过程映射并复制原视频音轨，不生成字幕或额外音频。

视频候选 `qualityReport.continuity` 记录验收是否通过、帧哈希、分辨率和来源镜头。此证据只证明镜头边界的解码像素一致，不代表后续画面中的人物身份、动作语义或整段视频质量已自动通过；这些仍需媒体质检和人工审看。

定向验证：

```bash
node --test server/services/video-first-frame.test.mjs server/services/video-last-frame.test.mjs server/services/video-wan.test.mjs server/video-persistence.contract.test.mjs
```
