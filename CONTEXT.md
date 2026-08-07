# FrameBaker 领域词汇

- **项目（Project）**：一组按 `idx` 排序、可逐帧编辑与播放并导出精灵表的帧。
- **帧（Frame）**：项目时间线中的一张图片及其 duration、关键帧标记和变换属性。
- **帧变换（Frame transform）**：以图片中心为锚点，依次解释 offset、rotation、scale，并在渲染时应用 opacity；编辑预览与导出共享同一几何语义。
- **素材（Material）**：可独立整理、抠图、剪裁并导入项目的图片或视频资产，保留 raw/processed 槽位。
- **导入工作流（Import workflow）**：文件从选择、可选剪裁、上传、排队到完成汇总的状态转换；项目导入与素材导入使用不同目标 adapter。
- **生成 provider（Generation provider）**：CLI 或外部图片/视频生成协议的配置与执行来源；配置每次调用实时从 settings 读取，环境变量仅作兜底。
- **生成产物（Generated artifact）**：provider 产出的图片或视频文件；提交时按目标成为项目帧或素材，并写入来源与生成元数据。
- **任务（Job）**：队列调度的拆帧、生成或抠图工作，拥有 queued/running/done/error/cancelled 生命周期。
- **抠图（Matting）**：从 raw 图片生成 processed 透明背景图片的异步任务。
