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
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { RenderTargets } from '../core/RenderTargets';

/**
 * Renders the scene from a mirrored camera into a reflection render target.
 */
export class ReflectionPass {
  private readonly renderTargets: RenderTargets;
  private target: WebGLRenderTarget | null = null;
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
    renderer: WebGLRenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    waterMesh: Mesh,
  ): void {
    if (!this.target) {
      return;
    }

    this.mirrorWorldPosition.setFromMatrixPosition(waterMesh.matrixWorld);
    this.waterY = this.mirrorWorldPosition.y;
    this.cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);

    this.rotationMatrix.extractRotation(camera.matrixWorld);

    this.normal.set(0, 1, 0);
    this.lookAtPosition.set(0, 0, -1);
    this.lookAtPosition.applyMatrix4(this.rotationMatrix);
    this.targetVec.copy(this.cameraWorldPosition).add(this.lookAtPosition);

    // Reflect camera position across the water plane.
    const offset = this.cameraWorldPosition.y - this.waterY;
    this.mirrorCamera.position.copy(this.cameraWorldPosition);
    this.mirrorCamera.position.y = this.waterY - offset;

    // Reflect the look-at target.
    const targetOffset = this.targetVec.y - this.waterY;
    this.targetVec.y = this.waterY - targetOffset;
    this.mirrorCamera.up.set(0, 1, 0);
    this.mirrorCamera.up.applyMatrix4(this.rotationMatrix);
    this.mirrorCamera.up.y = -this.mirrorCamera.up.y;
    this.mirrorCamera.lookAt(this.targetVec);

    this.mirrorCamera.far = camera.far;
    this.mirrorCamera.updateMatrixWorld();
    this.mirrorCamera.projectionMatrix.copy(camera.projectionMatrix);

    // Oblique near-plane clip so geometry below the mirror is clipped.
    this.mirrorPlane.setFromNormalAndCoplanarPoint(this.normal, this.mirrorWorldPosition);
    this.mirrorPlane.applyMatrix4(this.mirrorCamera.matrixWorldInverse);

    this.clipPlane.set(
      this.mirrorPlane.normal.x,
      this.mirrorPlane.normal.y,
      this.mirrorPlane.normal.z,
      this.mirrorPlane.constant,
    );

    const projectionMatrix = this.mirrorCamera.projectionMatrix;
    this.q.x = (Math.sign(this.clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    this.q.y = (Math.sign(this.clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    this.q.z = -1;
    this.q.w = (1 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];

    const dotQ = this.clipPlane.dot(this.q);
    if (Math.abs(dotQ) > 1e-6) {
      this.clipPlane.multiplyScalar(2 / dotQ);
      projectionMatrix.elements[2] = this.clipPlane.x;
      projectionMatrix.elements[6] = this.clipPlane.y;
      projectionMatrix.elements[10] = this.clipPlane.z + 1 - this.clipBias;
      projectionMatrix.elements[14] = this.clipPlane.w;
    }

    // Texture projection matrix for sampling in the water shader.
    this.textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0,
    );
    this.textureMatrix.multiply(this.mirrorCamera.projectionMatrix);
    this.textureMatrix.multiply(this.mirrorCamera.matrixWorldInverse);
    this.textureMatrix.multiply(waterMesh.matrixWorld);

    const prevTarget = renderer.getRenderTarget();
    const prevXr = renderer.xr.enabled;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;

    const wasVisible = waterMesh.visible;
    waterMesh.visible = false;

    renderer.setRenderTarget(this.target);
    renderer.state.buffers.depth.setMask(true);
    if (renderer.autoClear === false) {
      renderer.clear();
    }
    renderer.render(scene, this.mirrorCamera);

    waterMesh.visible = wasVisible;
    renderer.xr.enabled = prevXr;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
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
