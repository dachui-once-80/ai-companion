/**
 * connect 在 adoptOrReleaseLiveSession 之后的唯一副作用入口（1B-3D-2B2）。
 * 生产 RealtimeClient.connect 与离线测试共用本函数；禁止另写内联副本。
 */

export type PostAdoptConnectEffectsInput = {
  adopted: boolean;
  /** 必须 fire-and-forget；本 helper 不得 await 其返回值。 */
  scheduleBoundedDrainAfterConnect: () => void;
  cueReunion: () => void;
  startMicrophone: () => Promise<void>;
  /** 仅 adopted===true 且 startMicrophone 已 resolve 后调用。 */
  afterMicrophone: () => void;
};

/**
 * adopted===false：立即返回，不调用任何回调。
 * adopted===true：schedule（不 await）→ cueReunion → await startMicrophone → afterMicrophone。
 */
export async function runPostAdoptConnectEffects(
  input: PostAdoptConnectEffectsInput,
): Promise<void> {
  if (!input.adopted) return;

  input.scheduleBoundedDrainAfterConnect();
  input.cueReunion();
  await input.startMicrophone();
  input.afterMicrophone();
}
