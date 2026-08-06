const fs = require('fs');
let code = fs.readFileSync('src/entities/water/rendering/CausticsPass.ts', 'utf-8');
code = code.replace(/import \{[\s\S]*?\} from 'three';/, "import { OrthographicCamera, PlaneGeometry, Scene, MeshBasicMaterial, type Texture, Vector2, Vector3, Mesh, HalfFloatType, RGBAFormat, type WebGLRenderTarget, RenderTarget, type WebGLRenderer } from 'three';");
fs.writeFileSync('src/entities/water/rendering/CausticsPass.ts', code);
