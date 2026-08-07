import type { Camera, Mesh, PerspectiveCamera, Scene, Texture, WebGLRenderer } from 'three';
import type { WaterMaterial } from '../materials/WaterMaterial';
import { CausticsPass } from './CausticsPass';
import { ReflectionPass } from './ReflectionPass';
import { RefractionPass } from './RefractionPass';
import { isMobileDevice } from '../../../ui/mobileControls';

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

  constructor(material: WaterMaterial, causticsResolution = 256) {
    this.material = material;
    this.causticsResolution = causticsResolution;
    this.reflectionPass = new ReflectionPass();
    this.refractionPass = new RefractionPass();
    this.causticsPass = new CausticsPass();
  }

  /** Allocate pass targets. */
  initialize(width: number, height: number): void {
    const scale = isMobileDevice() ? 0.5 : 1.0;
    this.width = width * scale;
    this.height = height * scale;
    this.reflectionPass.initialize(this.width, this.height);
    this.refractionPass.initialize(this.width, this.height);
    this.causticsPass.initialize(this.causticsResolution);
    this.material.setResolution(width, height);
  }

  /**
   * Run reflection / refraction / caustics and bind results on the water material.
   */
  render(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    waterMesh: Mesh,
    heightMap: Texture | null,
  ): void {
    this.reflectionPass.setWaterLevel(waterMesh.position.y);

    if (this.isPerspectiveCamera(camera)) {
      const grass = scene.getObjectByName('Grass');
      if (grass) grass.visible = false;
      this.reflectionPass.render(renderer, scene, camera, waterMesh);
      if (grass) grass.visible = true;
    }

    this.refractionPass.render(renderer, scene, camera, waterMesh);
    this.causticsPass.render(renderer, heightMap);

    this.material.setReflectionMap(this.reflectionPass.texture);
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
    const scale = isMobileDevice() ? 0.5 : 1.0;
    this.width = width * scale;
    this.height = height * scale;
    this.reflectionPass.setSize(this.width, this.height);
    this.refractionPass.setSize(this.width, this.height);
    this.material.setResolution(this.width, this.height);
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
