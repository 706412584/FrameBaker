# 骨骼绑定调研与长期路线对齐结论

> 基于 2026-08-11 的骨骼绑定技术调研，并以 [`pose-motion-system.md`](./pose-motion-system.md) 的冻结架构决策和当前工作区实现为准。

## 结论

FrameBaker 当前的绑定质量上限受 CharacterBinding v1 的 Region Attachment 限制，但通用动画内核无需重做。已经交付的 `Skeleton`、`MotionClip`、`CharacterBinding` 和 `.fbanim` 继续作为事实源与演进基础。

长期主路线固定为：

1. **通用内核不绑定外部格式**：DragonBones、Spine、glTF、BVH 仅通过 adapter 导入导出，并产生 `CompatibilityReport`；外部字段和运行时不能成为内部 schema 或默认核心依赖。
2. **公开算法独立实现**：LBS、双骨 IK 等可参考公开论文和文档独立实现，不复制受限运行时代码。
3. **Region 与 Mesh 按附件混用**：不新增全局“像素/平滑模式”。角色主体可用 Region，披风、头发或高清素材可用 Mesh；运行时渲染策略由消费 `.fbanim` 的引擎负责。
4. **动作与外观继续分离**：Mesh 属于 CharacterBinding；Deform 是外观专属时间线，在正式归属冻结前不得加入可跨角色复用的 `MotionClip`。
5. **项目类型不互转**：骨骼项目只输出 `.fbanim`，逐帧项目独立维护 PNG 帧；不提供骨骼转逐帧兼容线路。

## 实施顺序

| 阶段 | 目标 | 主要交付与门禁 |
| --- | --- | --- |
| Phase B 收尾 | 完成现有编辑闭环 | cubic 曲线与事件 payload UI 已完成；下一步为根运动提取/可视化、接触感知循环工具；持续保持 `.fbanim` 确定性兼容 |
| Phase C | 通用交换与重定向 | BVH、glTF、语义映射、Rest Pose/比例/局部轴/根运动转换、CompatibilityReport、基础双骨 IK；至少两个外部来源可映射到同一 Skeleton |
| Phase D | 可替换动作 Provider | capability/request/artifact/provenance、持久化任务、候选确认与质量报告；移除 provider 后资产仍可编辑和导出 |
| Phase E1 | Mesh/LBS 高级形变 | CharacterBinding 新版本、Mesh Attachment、手工权重编辑、CPU LBS 权威实现与 Pixi 预览；由真实 Region 失败样例驱动 |
| Phase E2 | 2D 生态与高级约束 | DragonBones 优先 adapter、Spine 可选 adapter、ConstraintSet 版本化求值、附件切换与四足模板；许可和有损映射必须可审计 |

## Mesh 阶段进入条件

开始冻结 Mesh schema 前必须具备：

- 一组能稳定复现 Region 关节断裂或重叠问题的真实素材；
- 像素素材与高清素材各自的视觉验收图；
- 顶点、三角形和单顶点骨骼影响数预算；
- Region v1 无损兼容与独立 schemaVersion 迁移方案；
- 预览和运行时消费同一纯 LBS 求值结果的设计；
- 权重热力图、手工编辑、归一化、撤销和校验方案。

自动权重按“权重格式与校验 → 手工编辑 → 启发式建议 → 调和权重/BBW”递进。算法核心代码短不能替代编辑体验、迁移、确定性和样例回归。

## 外部运行时策略

DragonBones 的 MIT 社区运行时可以作为 adapter 开发期间的行为对照，但默认不 vendor 到 FrameBaker 核心。固定规范样例和双实现交叉验证比复制第三方运行时更能控制语义偏差，也避免永久承担其安全更新与 Pixi 升级成本。

Spine 运行时受专有许可约束，不进入 MIT 默认分发。未来若实现可选 adapter/plugin，必须隔离依赖并由用户满足许可证条件。
