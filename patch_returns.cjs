const fs = require('fs');
let code = fs.readFileSync('src/entities/water/simulation/RippleSimulation.ts', 'utf-8');
code = code.replace(/step\(renderer: WebGLRenderer, _delta: number\): void \{[\s\S]*?\n  \}/, 'step(renderer: any, _delta: number): void {\n    return;\n  }');
fs.writeFileSync('src/entities/water/simulation/RippleSimulation.ts', code);

let code2 = fs.readFileSync('src/entities/water/rendering/CausticsPass.ts', 'utf-8');
code2 = code2.replace(/render\(renderer: any, heightMap: Texture \| null\): void \{[\s\S]*?\n  \}/, 'render(renderer: any, heightMap: any): void {\n    return;\n  }');
fs.writeFileSync('src/entities/water/rendering/CausticsPass.ts', code2);
