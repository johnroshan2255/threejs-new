import {
  Color,
  type ColorRepresentation,
  DoubleSide,
  Matrix4,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import { UniformManager } from '../core/UniformManager';
import {
  DEFAULT_BRIGHTNESS,
  DEFAULT_CLARITY,
  DEFAULT_OPACITY,
  DEFAULT_REFLECTIVITY,
  DEFAULT_SHORE_FOAM,
  DEFAULT_SHORE_SOFTNESS,
  DEFAULT_WATER_COLOR,
} from '../core/Constants';
import commonGlsl from '../shaders/common.glsl?raw';
import waterFrag from '../shaders/water.frag?raw';
import waterVert from '../shaders/water.vert?raw';

export interface WaterMaterialOptions {
  color?: ColorRepresentation;
  opacity?: number;
  reflectivity?: number;
  resolution?: number;
  circular?: boolean;
  clarity?: number;
  shoreSoftness?: number;
  shoreFoam?: number;
  brightness?: number;
  sunDirection?: Vector3 | { x: number; y: number; z: number };
}

/**
 * Owns the water ShaderMaterial and its uniforms.
 *
 * Does not run simulation steps or reflection passes — only binds their outputs.
 */
export class WaterMaterial {
  private material: ShaderMaterial | null = null;
  private readonly uniforms = new UniformManager();
  private readonly simResolution: number;
  private readonly baseAbsorption = new Vector3(0.045, 0.016, 0.01);

  constructor(options: WaterMaterialOptions = {}) {
    this.simResolution = options.resolution ?? 256;

    this.uniforms.set('uColor', new Color(options.color ?? DEFAULT_WATER_COLOR));
    this.uniforms.set('uOpacity', options.opacity ?? DEFAULT_OPACITY);
    this.uniforms.set('uReflectivity', options.reflectivity ?? DEFAULT_REFLECTIVITY);
    this.uniforms.set('uTime', 0);
    this.uniforms.set('uReflectionMap', null);
    this.uniforms.set('uRefractionMap', null);
    this.uniforms.set('uDepthMap', null);
    this.uniforms.set('uHeightMap', null);
    this.uniforms.set('uHasHeightMap', 0);
    this.uniforms.set('uHasReflectionMap', 0);
    this.uniforms.set('uHasRefractionMap', 0);
    this.uniforms.set('uHasDepthMap', 0);
    this.uniforms.set('uHeightScale', 0.25);
    this.uniforms.set('uDistortionScale', 0.045);
    this.uniforms.set('uTextureMatrix', new Matrix4());
    this.uniforms.set('uSunDirection', new Vector3(0.3, 1.0, 0.2).normalize());
    this.uniforms.set('uTexelSize', new Vector2(1 / this.simResolution, 1 / this.simResolution));
    this.uniforms.set('uResolution', new Vector2(1, 1));
    this.uniforms.set('uCameraNear', 0.1);
    this.uniforms.set('uCameraFar', 200);
    this.uniforms.set('uAbsorption', this.baseAbsorption.clone());
    this.uniforms.set('uMaxDepth', 5.0);
    this.uniforms.set('uCircular', options.circular ? 1 : 0);
    this.uniforms.set('uClarity', options.clarity ?? DEFAULT_CLARITY);
    this.uniforms.set('uShoreSoftness', options.shoreSoftness ?? DEFAULT_SHORE_SOFTNESS);
    this.uniforms.set('uShoreFoam', options.shoreFoam ?? DEFAULT_SHORE_FOAM);
    this.uniforms.set('uBrightness', options.brightness ?? DEFAULT_BRIGHTNESS);

    this.applyClarity(options.clarity ?? DEFAULT_CLARITY);

    if (options.sunDirection) {
      this.setSunDirection(options.sunDirection);
    }
  }

  /** Build the ShaderMaterial from water.vert / water.frag. */
  initialize(): void {
    if (this.material) {
      return;
    }

    this.material = new ShaderMaterial({
      uniforms: this.uniforms.getAll(),
      vertexShader: waterVert,
      fragmentShader: `${commonGlsl}\n${waterFrag}`,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: true,
    });
  }

  get threeMaterial(): ShaderMaterial | null {
    return this.material;
  }

  setTime(time: number): void {
    this.uniforms.set('uTime', time);
  }

  setReflectionMap(texture: Texture | null): void {
    this.uniforms.set('uReflectionMap', texture);
    this.uniforms.set('uHasReflectionMap', texture ? 1 : 0);
  }

  setRefractionMap(texture: Texture | null): void {
    this.uniforms.set('uRefractionMap', texture);
    this.uniforms.set('uHasRefractionMap', texture ? 1 : 0);
  }

  setDepthMap(texture: Texture | null): void {
    this.uniforms.set('uDepthMap', texture);
    this.uniforms.set('uHasDepthMap', texture ? 1 : 0);
  }

  setCameraClip(near: number, far: number): void {
    this.uniforms.set('uCameraNear', near);
    this.uniforms.set('uCameraFar', far);
  }

  setHeightMap(texture: Texture | null): void {
    this.uniforms.set('uHeightMap', texture);
    this.uniforms.set('uHasHeightMap', texture ? 1 : 0);
  }

  setTextureMatrix(matrix: Matrix4): void {
    const current = this.uniforms.get<Matrix4>('uTextureMatrix');
    if (current) {
      current.copy(matrix);
    } else {
      this.uniforms.set('uTextureMatrix', matrix.clone());
    }
  }

  setResolution(width: number, height: number): void {
    const resolution = this.uniforms.get<Vector2>('uResolution');
    if (resolution) {
      resolution.set(width, height);
    } else {
      this.uniforms.set('uResolution', new Vector2(width, height));
    }
  }

  /** 0 = murky, 1 = crystal clear. */
  setClarity(value: number): void {
    const clarity = Math.min(1, Math.max(0, value));
    this.uniforms.set('uClarity', clarity);
    this.applyClarity(clarity);
  }

  /** 0 = hard circular edge, 1 = wide soft shore blend. */
  setShoreSoftness(value: number): void {
    this.uniforms.set('uShoreSoftness', Math.min(1, Math.max(0, value)));
  }

  /** Shore foam / bright rim intensity. */
  setShoreFoam(value: number): void {
    this.uniforms.set('uShoreFoam', Math.min(1, Math.max(0, value)));
  }

  setBrightness(value: number): void {
    this.uniforms.set('uBrightness', Math.max(0.5, value));
  }

  setSunDirection(dir: Vector3 | { x: number; y: number; z: number }): void {
    const current = this.uniforms.get<Vector3>('uSunDirection');
    const next = current ?? new Vector3();
    next.set(dir.x, dir.y, dir.z).normalize();
    this.uniforms.set('uSunDirection', next);
  }

  setUniform<T>(name: string, value: T): void {
    this.uniforms.set(name, value);
  }

  dispose(): void {
    this.material?.dispose();
    this.material = null;
  }

  private applyClarity(clarity: number): void {
    // Higher clarity → weaker absorption.
    const scale = 1.35 - clarity;
    const absorption = this.uniforms.get<Vector3>('uAbsorption') ?? this.baseAbsorption.clone();
    absorption.copy(this.baseAbsorption).multiplyScalar(scale);
    this.uniforms.set('uAbsorption', absorption);
  }
}
