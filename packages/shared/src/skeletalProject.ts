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
  /** 具体角色及其素材绑定只属于本项目，不进入动作资产库。 */
  character: { binding: CharacterBinding } | null;
  animations: SkeletalProjectAnimation[];
  activeAnimationId: string | null;
}

export interface SkeletalProjectDocumentResponse {
  document: SkeletalProjectDocument;
}
