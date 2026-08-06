const fs = require('fs');

let caustics = fs.readFileSync('src/entities/water/rendering/CausticsPass.ts', 'utf-8');
caustics = caustics.replace(/import \{[\s\S]*?\} from 'three';/, "import { OrthographicCamera, PlaneGeometry, Scene, MeshBasicMaterial, type Texture, Vector2, Vector3, Mesh, HalfFloatType, RGBAFormat, type WebGLRenderTarget } from 'three';");
caustics = caustics.replace(/private material: ShaderMaterial \| null = null;/, 'private material: any | null = null;');
caustics = caustics.replace(/this\.target = this\.renderTargets\.create\([\s\S]*?\);/, 'this.target = this.renderTargets.create(resolution, resolution, { depthBuffer: false, stencilBuffer: false }) as any;');
caustics = caustics.replace(/this\.material = new ShaderMaterial\(\{[\s\S]*?\}\);/, 'this.material = new MeshBasicMaterial({ color: 0xffffff });');
caustics = caustics.replace(/render\(renderer: any, heightMap: Texture \| null\): void \{[\s\S]*?\n  \}/, 'render(renderer: any, heightMap: Texture | null): void { return; }');
fs.writeFileSync('src/entities/water/rendering/CausticsPass.ts', caustics);

let ripple = fs.readFileSync('src/entities/water/simulation/RippleSimulation.ts', 'utf-8');
ripple = ripple.replace(/private simMaterial: MeshBasicMaterial \| null = null;/, 'private simMaterial: any | null = null;');
ripple = ripple.replace(/private disturbanceMaterial: MeshBasicMaterial \| null = null;/, 'private disturbanceMaterial: any | null = null;');
fs.writeFileSync('src/entities/water/simulation/RippleSimulation.ts', ripple);
