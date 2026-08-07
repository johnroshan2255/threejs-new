import type { Camera, Mesh, PerspectiveCamera, Scene, Texture } from 'three';
import type { WaterMaterial } from '../materials/WaterMaterial';
import { CausticsPass } from './CausticsPass';
import { ReflectionPass } from './ReflectionPass';
import { RefractionPass } from './RefractionPass';

/**
 * Orchestrates reflection / refraction / caustics and feeds textures into the material.
 */
export class WaterRenderer {
  private readonly reflectionPass: ReflectionPass;
  private readonly refractionPass: RefractionPass;
  private readonly causticsPass: CausticsPass;
  private readonly material: WaterMaterial;
  private width = 512;
  private height = 512;
  private causticsResolution = 256;
  public enableReflections = true;

  constructor(material: WaterMaterial, causticsResolution = 256) {
    this.material = material;
    this.causticsResolution = causticsResolution;
    this.reflectionPass = new ReflectionPass();
    this.refractionPass = new RefractionPass();
    this.causticsPass = new CausticsPass();
  }

  /**
   * Reflections are resampled through the wave normals, which smears away most
   * of their detail before it reaches the screen — half resolution is free.
   */
  private static readonly REFLECTION_SCALE = 0.5;

  private static scaled(v: number): number {
    return Math.max(1, Math.floor(v * WaterRenderer.REFLECTION_SCALE));
  }

  /** Allocate pass targets. */
  initialize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.reflectionPass.initialize(
      WaterRenderer.scaled(width),
      WaterRenderer.scaled(height),
    );
    this.refractionPass.initialize(width, height);
    this.causticsPass.initialize(this.causticsResolution);
    this.material.setResolution(width, height);
  }

  prepareCaustics(textureA: Texture, textureB: Texture): void {
    this.causticsPass.prepare(textureA, textureB);
  }

  /**
   * Run reflection / refraction / caustics and bind results on the water material.
   */
  render(
    renderer: any,
    scene: Scene,
    camera: Camera,
    waterMesh: Mesh,
    heightMap: Texture | null,
  ): void {
    this.reflectionPass.setWaterLevel(waterMesh.position.y);

    if (this.enableReflections && this.isPerspectiveCamera(camera)) {
      // Every grass field is hidden for the mirror pass, not just the first one
      // getObjectByName happens to return. A world carries one "Grass" group per
      // field — island, pond surround, each custom-world patch — and together
      // they are ~196 chunks and ~900k triangles, by far the heaviest thing in
      // the scene. Reflected grass at water level is a few smeared pixels behind
      // the wave distortion, so re-rendering all of it was the single most
      // expensive thing the water did.
      const grass = scene.getObjectsByProperty('name', 'Grass');
      for (const g of grass) g.visible = false;
      this.reflectionPass.render(renderer, scene, camera, waterMesh);
      for (const g of grass) g.visible = true;
    }

    this.refractionPass.render(renderer, scene, camera, waterMesh);
    this.causticsPass.render(renderer, heightMap);

    if (this.enableReflections) {
      this.material.setReflectionMap(this.reflectionPass.texture);
    }
    this.material.setRefractionMap(this.refractionPass.texture);
    this.material.setDepthMap(this.refractionPass.depthTexture);
    this.material.setTextureMatrix(this.reflectionPass.getTextureMatrix());
    this.material.setResolution(this.width, this.height);

    if (this.isPerspectiveCamera(camera)) {
      this.material.setCameraClip(camera.near, camera.far);
    }
  }

  get causticsTexture(): Texture | null {
    return this.causticsPass.texture;
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.reflectionPass.setSize(
      WaterRenderer.scaled(width),
      WaterRenderer.scaled(height),
    );
    this.refractionPass.setSize(width, height);
    this.material.setResolution(width, height);
  }

  dispose(): void {
    this.reflectionPass.dispose();
    this.refractionPass.dispose();
    this.causticsPass.dispose();
  }

  private isPerspectiveCamera(camera: Camera): camera is PerspectiveCamera {
    return (camera as PerspectiveCamera).isPerspectiveCamera === true;
  }
}
