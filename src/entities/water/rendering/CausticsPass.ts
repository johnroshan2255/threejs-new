import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';
import { causticsFrag, causticsVert } from '../shaders/caustics';

/**
 * Renders a caustic intensity map from the water heightfield.
 */
export class CausticsPass {
  private readonly renderTargets: RenderTargets;
  private target: WebGLRenderTarget | null = null;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: ShaderMaterial | null = null;
  private quad: Mesh | null = null;
  private readonly lightDir = new Vector3(0.3, 1.0, 0.2).normalize();

  constructor(renderTargets: RenderTargets = new RenderTargets()) {
    this.renderTargets = renderTargets;
  }

  initialize(resolution: number): void {
    if (this.target) {
      return;
    }

    this.target = this.renderTargets.create(resolution, resolution, {
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.target.texture.generateMipmaps = false;

    this.material = new ShaderMaterial({
      uniforms: {
        uHeightMap: { value: null },
        uTexelSize: { value: new Vector2(1 / resolution, 1 / resolution) },
        uLightDir: { value: this.lightDir.clone() },
        uIntensity: { value: 1.4 },
      },
      vertexShader: causticsVert,
      fragmentShader: causticsFrag,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  render(renderer: WebGLRenderer, heightMap: Texture | null): void {
    if (!this.target || !this.material || !heightMap) {
      return;
    }

    this.material.uniforms.uHeightMap.value = heightMap;

    const prev = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prev);
  }

  get texture(): Texture | null {
    return this.target?.texture ?? null;
  }

  dispose(): void {
    this.material?.dispose();
    this.quad?.geometry.dispose();
    this.renderTargets.dispose();
    this.target = null;
    this.material = null;
    this.quad = null;
  }
}
