import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three';
import { StorageTexture } from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  float,
  globalId,
  ivec2,
  length,
  normalize,
  pow,
  refract,
  texture,
  textureLoad,
  textureStore,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';

/**
 * Renders a caustic intensity map from the water heightfield.
 *
 * Simplified differential-area look: focus is approximated from how parallel
 * neighbouring refracted rays are, which is cheap and reads correctly at the
 * scale a pond floor is ever seen at.
 *
 * A compute dispatch rather than a fullscreen draw — it is a per-texel stencil
 * over the heightfield with no geometry involved, so a render pass bought
 * nothing but attachment setup.
 */
export class CausticsPass {
  private target: StorageTexture | null = null;
  private kernels: [any, any] | null = null;
  private boundTextures: [Texture, Texture] | null = null;
  private resolution = 0;

  private readonly uLightDir = uniform(new Vector3(0.3, 1.0, 0.2).normalize());
  private readonly uIntensity = uniform(1);

  initialize(resolution: number): void {
    if (this.target) {
      return;
    }
    this.resolution = resolution;
    this.target = new StorageTexture(resolution, resolution);
    this.target.type = HalfFloatType;
    this.target.format = RGBAFormat;
    this.target.minFilter = LinearFilter;
    this.target.magFilter = LinearFilter;
    this.target.wrapS = ClampToEdgeWrapping;
    this.target.wrapT = ClampToEdgeWrapping;
    this.target.generateMipmaps = false;
  }

  /** Call once both ping-pong textures are known (e.g. from RippleSimulation.initialize). */
  prepare(textureA: Texture, textureB: Texture): void {
    this.boundTextures = [textureA, textureB];
    this.kernels = [this.buildKernel(textureA), this.buildKernel(textureB)];
  }

  /**
   * The kernel bakes in its source texture, so it is rebuilt only when the
   * simulation hands over a different heightfield — not per frame.
   */
  private buildKernel(heightMap: Texture): any {
    const res = this.resolution;
    const last = res - 1;
    const dst = this.target!;

    const at = (coord: any, dx: number, dy: number) =>
      textureLoad(
        heightMap,
        (clamp as any)(coord.add(ivec2(dx, dy)), ivec2(0, 0), ivec2(last, last)) as any,
      ).r;

    return Fn(() => {
      const coord: any = ivec2(globalId.xy);
      const hC = at(coord, 0, 0).toVar();
      const hL = at(coord, -1, 0).toVar();
      const hR = at(coord, 1, 0).toVar();
      const hD = at(coord, 0, -1).toVar();
      const hU = at(coord, 0, 1).toVar();

      const normal: any = normalize(vec3(hL.sub(hR), 0.15, hD.sub(hU)));
      const L: any = normalize(this.uLightDir);

      // Refract light through the surface toward the floor.
      const refracted: any = refract(L.negate(), normal, 0.75);
      // Focus intensity ~ how parallel neighbouring refracted rays are.
      const focus = clamp(length(refracted.xz).mul(2.5), 0.0, 1.0).oneMinus();
      const laplacian = abs(hL.add(hR).add(hD).add(hU).sub(hC.mul(4.0)));
      const caustic = pow(focus, 2.0).mul(laplacian.mul(18.0).add(0.35));

      textureStore(
        dst,
        coord,
        vec4(vec3(clamp(caustic.mul(this.uIntensity), 0.0, 4.0)), 1.0),
      ).toWriteOnly();
    })().compute([res, res] as any, [8, 8] as any);
  }

  render(renderer: any, heightMap: Texture | null): void {
    if (!this.target || !heightMap || !this.kernels || !this.boundTextures) {
      return;
    }

    const index = heightMap === this.boundTextures[0] ? 0 : 1;
    renderer.compute(this.kernels[index]);
  }

  get texture(): Texture | null {
    return this.target;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.kernels = null;
    this.boundTextures = null;
  }
}
