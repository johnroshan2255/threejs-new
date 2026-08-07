import type { Light, LightShadow, Object3D } from 'three';

export type FrozenShadows = Array<{
  shadow: LightShadow;
  autoUpdate: boolean;
  needsUpdate: boolean;
}>;

/**
 * Stop a nested render from rebuilding every shadow map.
 *
 * Under WebGL there was one switch for this — `renderer.shadowMap.autoUpdate`.
 * The node renderer has no renderer-wide equivalent: each light's `ShadowNode`
 * decides for itself, and it re-renders whenever it sees a camera it has not
 * drawn for on this frame. The water's reflection and refraction passes each
 * introduce exactly that: a second and third camera per frame, which without
 * this would triple the cost of the shadow pass.
 *
 * The maps are still bound and sampled — only their *update* is suppressed, so
 * reflections keep their shadows and simply reuse the ones drawn for the main
 * camera.
 */
export function freezeSceneShadows(scene: Object3D): FrozenShadows {
  const frozen: FrozenShadows = [];
  scene.traverse((object) => {
    const shadow = (object as Light & { shadow?: LightShadow }).shadow;
    if (!shadow) return;
    frozen.push({
      shadow,
      autoUpdate: shadow.autoUpdate,
      needsUpdate: shadow.needsUpdate,
    });
    shadow.autoUpdate = false;
    shadow.needsUpdate = false;
  });
  return frozen;
}

export function restoreSceneShadows(frozen: FrozenShadows): void {
  for (const entry of frozen) {
    entry.shadow.autoUpdate = entry.autoUpdate;
    entry.shadow.needsUpdate = entry.needsUpdate;
  }
  frozen.length = 0;
}
