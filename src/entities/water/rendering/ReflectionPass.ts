import {
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Matrix4,
  type Mesh,
  PerspectiveCamera,
  Plane,
  type Scene,
  type Texture,
  Vector3,
  Vector4,
  type RenderTarget,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';

/**
 * Renders the scene from a mirrored camera into a reflection render target.
 */
export class ReflectionPass {
  private readonly renderTargets: RenderTargets;
  private target: RenderTarget | null = null;
  private readonly mirrorCamera = new PerspectiveCamera();
  private readonly textureMatrix = new Matrix4();
  private readonly mirrorPlane = new Plane();
  private readonly normal = new Vector3(0, 1, 0);
  private readonly mirrorWorldPosition = new Vector3();
  private readonly cameraWorldPosition = new Vector3();
  private readonly rotationMatrix = new Matrix4();
  private readonly lookAtPosition = new Vector3(0, 0, -1);
  private readonly targetVec = new Vector3();
  private readonly clipPlane = new Vector4();
  private readonly q = new Vector4();
  private clipBias = 0.0001;
  private waterY = 0;

  constructor(renderTargets: RenderTargets = new RenderTargets()) {
    this.renderTargets = renderTargets;
  }

  /** Allocate the reflection RT. */
  initialize(width: number, height: number): void {
    if (this.target) {
      this.setSize(width, height);
      return;
    }

    this.target = this.renderTargets.create(width, height, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
    });
    this.target.texture.generateMipmaps = false;
    this.target.texture.colorSpace = LinearSRGBColorSpace;
  }

  setWaterLevel(y: number): void {
    this.waterY = y;
  }

  getTextureMatrix(): Matrix4 {
    return this.textureMatrix;
  }

  /**
   * Render reflected scene into the pass target.
   */
  render(
    renderer: any,
    scene: Scene,
    camera: PerspectiveCamera,
    waterMesh: Mesh,
  ): void {
    return;
  }

  get texture(): Texture | null {
    return this.target?.texture ?? null;
  }

  setSize(width: number, height: number): void {
    this.target?.setSize(width, height);
  }

  dispose(): void {
    this.renderTargets.dispose();
    this.target = null;
  }
}
