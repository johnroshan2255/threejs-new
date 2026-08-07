import {
  Color,
  type ColorRepresentation,
  DataTexture,
  DoubleSide,
  Matrix4,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn,
  If,
  abs,
  attribute,
  clamp,
  dot,
  float,
  length,
  max,
  mix,
  normalLocal,
  normalize,
  positionLocal,
  positionView,
  positionWorld,
  pow,
  screenUV,
  smoothstep,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  absorbWater,
  animatedRippleOffset,
  fresnelSchlick,
  perspectiveDepthToViewZ,
} from '../shaders/commonNodes';
import { UniformManager } from '../core/UniformManager';
import {
  DEFAULT_BRIGHTNESS,
  DEFAULT_CLARITY,
  DEFAULT_OPACITY,
  DEFAULT_REFLECTIVITY,
  DEFAULT_SHORE_FOAM,
  DEFAULT_SHORE_SOFTNESS,
  DEFAULT_WATER_COLOR,
  MAX_SLOPE_GAIN,
  REFERENCE_SLOPE_GAIN,
  REFERENCE_TEXELS_PER_METER,
  WAVE_PERIOD_METERS,
} from '../core/Constants';

/**
 * Stand-in for the pass outputs until they exist.
 *
 * The sampled result is always gated by the matching `uHasXMap` flag, so the
 * value never reaches the image — but a texture node still needs *something*
 * bound, and a 1x1 black texel is the cheapest thing that satisfies that.
 */
const PLACEHOLDER_TEXTURE = /*#__PURE__*/ (() => {
  const tex = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat);
  tex.needsUpdate = true;
  return tex;
})();

export interface WaterMaterialOptions {
  color?: ColorRepresentation;
  opacity?: number;
  reflectivity?: number;
  resolution?: number;
  /** Pond size in world units — wave tiling and slope gain scale with it. */
  width?: number;
  height?: number;
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
  private material: MeshBasicNodeMaterial | null = null;
  private readonly uniforms = new UniformManager();
  private readonly simResolution: number;
  private readonly baseAbsorption = new Vector3(0.045, 0.016, 0.01);
  /** The same uniforms as `this.uniforms`, typed as nodes for the graph. */
  private nodes!: Record<string, any>;

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
    this.uniforms.set('uLightColor', new Color(1, 1, 1));
    this.uniforms.set('uTexelSize', new Vector2(1 / this.simResolution, 1 / this.simResolution));

    // Waves per pond, derived from world size: a 20 m pond keeps the tuned 2.5
    // cycles; a 60 m lake gets 7.5 rather than the same 2.5 stretched out.
    const worldWidth = Math.max(0.001, options.width ?? 20);
    const worldHeight = Math.max(0.001, options.height ?? 20);
    this.uniforms.set(
      'uWaveTiles',
      new Vector2(worldWidth / WAVE_PERIOD_METERS, worldHeight / WAVE_PERIOD_METERS),
    );

    // Height derivatives are measured in texels. Once a texel covers more than
    // the reference ~8 cm, a ripple spans fewer texels and its normals flatten —
    // lift the gain by that shortfall so the surface keeps its sparkle.
    const texelsPerMeter = this.simResolution / Math.max(worldWidth, worldHeight);
    this.uniforms.set(
      'uSlopeGain',
      Math.min(
        MAX_SLOPE_GAIN,
        Math.max(
          REFERENCE_SLOPE_GAIN,
          REFERENCE_SLOPE_GAIN * (REFERENCE_TEXELS_PER_METER / texelsPerMeter),
        ),
      ),
    );

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

    this.buildNodes();
  }

  /**
   * Turn every uniform into its TSL equivalent, in place.
   *
   * Done once, after the constructor has written all the initial values, so the
   * nodes start out already carrying them. Every setter on this class continues
   * to go through `UniformManager.set`, which now writes straight into a node.
   */
  private buildNodes(): void {
    const u = this.uniforms;
    const scalar = (name: string) => u.promote(name, uniform(u.get<number>(name) ?? 0));
    const map = (name: string) =>
      u.promote(name, texture(u.get<Texture>(name) ?? PLACEHOLDER_TEXTURE));

    this.nodes = {
      uColor: u.promote('uColor', uniform(u.get<Color>('uColor')!)),
      uSunDirection: u.promote('uSunDirection', uniform(u.get<Vector3>('uSunDirection')!)),
      uLightColor: u.promote('uLightColor', uniform(u.get<Color>('uLightColor')!)),
      uAbsorption: u.promote('uAbsorption', uniform(u.get<Vector3>('uAbsorption')!)),
      uTexelSize: u.promote('uTexelSize', uniform(u.get<Vector2>('uTexelSize')!)),
      uWaveTiles: u.promote('uWaveTiles', uniform(u.get<Vector2>('uWaveTiles')!)),
      uResolution: u.promote('uResolution', uniform(u.get<Vector2>('uResolution')!)),
      uTextureMatrix: u.promote('uTextureMatrix', uniform(u.get<Matrix4>('uTextureMatrix')!)),

      uReflectionMap: map('uReflectionMap'),
      uRefractionMap: map('uRefractionMap'),
      uDepthMap: map('uDepthMap'),
      uHeightMap: map('uHeightMap'),

      uOpacity: scalar('uOpacity'),
      uReflectivity: scalar('uReflectivity'),
      uTime: scalar('uTime'),
      uHasHeightMap: scalar('uHasHeightMap'),
      uHasReflectionMap: scalar('uHasReflectionMap'),
      uHasRefractionMap: scalar('uHasRefractionMap'),
      uHasDepthMap: scalar('uHasDepthMap'),
      uHeightScale: scalar('uHeightScale'),
      uDistortionScale: scalar('uDistortionScale'),
      uSlopeGain: scalar('uSlopeGain'),
      uCameraNear: scalar('uCameraNear'),
      uCameraFar: scalar('uCameraFar'),
      uMaxDepth: scalar('uMaxDepth'),
      uCircular: scalar('uCircular'),
      uClarity: scalar('uClarity'),
      uShoreSoftness: scalar('uShoreSoftness'),
      uShoreFoam: scalar('uShoreFoam'),
      uBrightness: scalar('uBrightness'),
    };
  }

  /**
   * Build the node material — the port of water.vert / water.frag.
   *
   * Unlit on purpose, as the GLSL version was: reflection, refraction, depth
   * absorption and the sun glint are all computed here from the pass outputs,
   * so handing the surface to a standard lighting model would double-count.
   */
  initialize(): void {
    if (this.material) {
      return;
    }

    const u = this.nodes;

    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });

    // Rectangular editor basins carry a per-vertex shore weight; circular ponds
    // derive theirs from the UV radius instead. Defaults to 1 (= full water) so
    // geometry without the attribute is unaffected.
    const vShore: any = varying(attribute('aShore', 'float').toVar(), 'vWaterShore');

    material.positionNode = Fn(() => {
      // Geometry stays mostly flat — a light offset for the larger waves only,
      // which keeps the silhouette stable without a full vertex-texture displace.
      const height = u.uHeightMap
        .sample(uv())
        .r.mul(u.uHeightScale)
        .mul(u.uHasHeightMap);
      return positionLocal.add(normalLocal.mul(height).mul(0.35));
    })();

    const shading = Fn(() => {
      const p = uv().toVar();
      const radial = length(p.sub(vec2(0.5)));
      const shore = float(1.0).toVar();
      const shoreMask = float(0.0).toVar();

      If(u.uCircular.greaterThan(0.5), () => {
        // Wider soft rim when shoreSoftness is high (0 → thin, 1 → ~0.18 UV).
        const rimWidth = mix(0.04, 0.18, u.uShoreSoftness);
        const outer = float(0.5);
        const inner = max(float(0.15), outer.sub(rimWidth)).toVar();

        radial.greaterThan(outer).discard();

        shore.assign(smoothstep(inner, outer, radial).oneMinus());
        // Foam ring concentrated near the grass edge.
        shoreMask.assign(
          smoothstep(inner, mix(inner, outer, 0.55), radial).mul(
            smoothstep(mix(inner, outer, 0.7), outer, radial).oneMinus()
          )
        );
      });

      // Irregular editor basins: optional aShore soft rim (1 = full water).
      shore.mulAssign(max(vShore, 0.001));
      shoreMask.assign(max(shoreMask, vShore.oneMinus().mul(0.85)));
      // Outside the basin mask — cut completely (dense plane is rectangular).
      vShore.lessThan(0.05).and(u.uCircular.lessThan(0.5)).discard();

      const viewPos: any = positionView.negate().toVar();
      const viewDir: any = normalize(viewPos);

      // Tiling comes from world size, so a wave cycle stays ~8 m on any pond.
      const wave = animatedRippleOffset(p.mul(u.uWaveTiles), u.uTime).mul(0.04);
      const normal: any = normalize(vec3(wave.x, 1.0, wave.y)).toVar();

      const texel = u.uTexelSize;
      const hL = u.uHeightMap.sample(p.sub(vec2(texel.x, 0.0))).r;
      const hR = u.uHeightMap.sample(p.add(vec2(texel.x, 0.0))).r;
      const hD = u.uHeightMap.sample(p.sub(vec2(0.0, texel.y))).r;
      const hU = u.uHeightMap.sample(p.add(vec2(0.0, texel.y))).r;
      const heightNormal: any = normalize(
        vec3(hL.sub(hR).mul(u.uSlopeGain), 1.0, hD.sub(hU).mul(u.uSlopeGain))
      );
      // `uHasHeightMap` gates by blend rather than by branch — the samples above
      // are against a 1x1 placeholder until the simulation binds a real target.
      normal.assign(
        normalize(mix(normal, heightNormal, u.uHasHeightMap.mul(0.95)) as any)
      );

      // Soften distortion near shore so the edge stays readable.
      const distortion = normal.xz
        .mul(u.uDistortionScale)
        .mul(mix(0.35, 1.0, shore))
        .toVar();

      const reflectCoord: any = u.uTextureMatrix.mul(vec4(positionWorld, 1.0));
      const reflectUv = clamp(
        reflectCoord.xy.div(max(reflectCoord.w, float(1e-4))).add(distortion),
        vec2(0.002),
        vec2(0.998)
      );

      // Fallback sky tint, scaled by light energy — a fixed pale blue here
      // stayed fully bright at night whenever no reflection map was bound.
      const skyTint = u.uLightColor.mul(vec3(0.55, 0.75, 0.95));
      const reflection: any = mix(
        skyTint,
        u.uReflectionMap.sample(reflectUv).rgb,
        u.uHasReflectionMap
      );

      const screenUv: any = clamp(
        screenUV.add(distortion.mul(0.85)) as any,
        vec2(0.002),
        vec2(0.998)
      ).toVar();

      // Real refraction of the scene (threejs-water look) — not a flat blue fill.
      const underwater: any = mix(
        vec3(0.55, 0.5, 0.35),
        u.uRefractionMap.sample(screenUv).rgb,
        u.uHasRefractionMap
      ).toVar();

      const waterDepth = float(1.2).toVar();
      If(u.uHasDepthMap.greaterThan(0.5), () => {
        const rawDepth = u.uDepthMap.sample(screenUv).x.toVar();
        If(rawDepth.lessThan(0.999), () => {
          const sceneViewZ = perspectiveDepthToViewZ(
            rawDepth,
            u.uCameraNear,
            u.uCameraFar
          );
          const surfaceEyeZ = length(viewPos);
          waterDepth.assign(
            clamp(sceneViewZ.negate().sub(surfaceEyeZ), 0.02, u.uMaxDepth)
          );
        }).Else(() => {
          waterDepth.assign(0.2);
        });
      });

      // Clarity: high = show more bottom, weaker tint.
      const clarity = clamp(u.uClarity, 0.0, 1.0).toVar();
      const absorbScale = mix(0.85, 0.2, clarity);
      const absorbed = absorbWater(
        underwater,
        waterDepth.mul(absorbScale),
        u.uAbsorption
      );
      const depthNorm = clamp(
        waterDepth.div(max(u.uMaxDepth, float(0.001))),
        0.0,
        1.0
      );

      const refraction: any = mix(
        underwater,
        absorbed,
        mix(0.45, 0.12, clarity).add(depthNorm.mul(mix(0.3, 0.12, clarity)))
      ).toVar();
      refraction.assign(mix(refraction, underwater, mix(0.15, 0.45, clarity)));
      refraction.assign(
        mix(
          refraction,
          refraction.add(u.uColor.mul(0.12)),
          mix(0.45, 0.2, clarity)
        )
      );
      // Near shore, bias even more toward seeing the terrain.
      refraction.assign(mix(refraction, underwater, shoreMask.mul(0.55)));

      const ndotv = max(dot(normal, viewDir), 0.0);
      const fresnel = fresnelSchlick(ndotv, mix(0.015, 0.1, u.uReflectivity));
      const mixFactor = clamp(fresnel.mul(fresnel), 0.0, 0.55)
        .mul(mix(1.0, 0.65, shoreMask))
        .toVar();

      const color: any = mix(refraction, reflection, mixFactor)
        .mul(u.uBrightness)
        .toVar();

      const halfDir = normalize(viewDir.add(normalize(u.uSunDirection)));

      // Widen and fade the lobe with distance. A 220-exponent highlight is far
      // narrower than a distant pixel covers, so the ripple normals undersample
      // it into isolated bright specks that flicker as the camera moves — and
      // bloom then turns each speck into a blinking light. Near water keeps the
      // tight glint; far water gets a broad, stable one.
      const farFade = smoothstep(45.0, 160.0, length(viewPos)).oneMinus().toVar();
      const specPower = mix(40.0, 220.0, farFade);
      const spec = pow(max(dot(normal, halfDir), 0.0), specPower);

      // Scaled by the scene's light energy, not a hardcoded white: a constant
      // highlight becomes a glowing disc once the night rig gets genuinely dark.
      color.addAssign(
        u.uLightColor.mul(spec).mul(0.45).mul(mix(0.35, 1.0, farFade))
      );

      const surfaceHeight = u.uHeightMap.sample(p).r.mul(u.uHeightScale);
      const foam = smoothstep(
        0.04,
        0.14,
        abs(surfaceHeight).add(length(normal.xz).mul(0.08))
      ).mul(u.uHasHeightMap);

      const shoreFoam = shoreMask.mul(u.uShoreFoam);
      // Foam brightens the water it sits on rather than replacing it with a near
      // white constant. Blending toward an absolute colour made the shore rim a
      // free-standing bright ring — brighter than anything around it at night,
      // and strong enough to bloom into a glowing disc.
      const foamColor: any = mix(
        color.mul(1.8),
        u.uLightColor.mul(vec3(0.92, 0.97, 1.0)),
        0.45
      );
      const foamAmount: any = max(foam.mul(0.22), shoreFoam);
      color.assign(mix(color, foamColor, foamAmount));

      // Soft alpha falloff at the circular / basin rim (blends into grass).
      return vec4(color, mix(0.97, 1.0, mixFactor).mul(shore) as any);
    })().toVar() as any;

    material.colorNode = shading.rgb;
    material.opacityNode = shading.a;

    this.material = material;
  }

  get threeMaterial(): MeshBasicNodeMaterial | null {
    return this.material;
  }

  setTime(time: number): void {
    this.uniforms.set('uTime', time);
  }

  setReflectionMap(map: Texture | null): void {
    this.bindMap('uReflectionMap', 'uHasReflectionMap', map);
  }

  setRefractionMap(map: Texture | null): void {
    this.bindMap('uRefractionMap', 'uHasRefractionMap', map);
  }

  setDepthMap(map: Texture | null): void {
    this.bindMap('uDepthMap', 'uHasDepthMap', map);
  }

  /**
   * A texture node must always have something bound, so unbinding falls back to
   * the placeholder and lets the `has` flag do the actual gating.
   */
  private bindMap(mapName: string, flagName: string, map: Texture | null): void {
    this.uniforms.set(mapName, map ?? PLACEHOLDER_TEXTURE);
    this.uniforms.set(flagName, map ? 1 : 0);
  }

  setCameraClip(near: number, far: number): void {
    this.uniforms.set('uCameraNear', near);
    this.uniforms.set('uCameraFar', far);
  }

  setHeightMap(map: Texture | null): void {
    this.bindMap('uHeightMap', 'uHasHeightMap', map);
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

  /**
   * Scene light energy driving specular + foam brightness. Without this they
   * are constants, which blows out to a white disc once night gets dark.
   */
  setLightColor(color: Color): void {
    const current = this.uniforms.get<Color>('uLightColor');
    const next = current ?? new Color();
    next.copy(color);
    this.uniforms.set('uLightColor', next);
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
