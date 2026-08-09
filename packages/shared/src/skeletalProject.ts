import type { CharacterBinding } from "./animation";

/** 骨骼项目中的一条动作配置；动作资产本身由 MotionClip 共享。 */
export interface SkeletalProjectAnimation {
  id: string;
  name: string;
  motionClipId: string;
  speed: number;
  repeat: number;
  loop: boolean;
}

/** 骨骼项目持久化文档 v1。 */
export interface SkeletalProjectDocument {
  schemaVersion: 1;
  projectId: string;
  /** 从动作资产库复制进项目的角色；之后可在项目内独立调整，不改动原资产。 */
  character: { sourceBindingId: string | null; binding: CharacterBinding } | null;
  animations: SkeletalProjectAnimation[];
  activeAnimationId: string | null;
}

export interface SkeletalProjectDocumentResponse {
  document: SkeletalProjectDocument;
}
