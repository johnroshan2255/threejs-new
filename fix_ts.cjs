const fs = require('fs');
let code = fs.readFileSync('src/entities/water/simulation/RippleSimulation.ts', 'utf-8');
code = code.replace(/renderer\.setRenderTarget\(this\.readTarget as any\);/g, '// @ts-ignore\n    renderer.setRenderTarget(this.readTarget as any);');
code = code.replace(/renderer\.setRenderTarget\(this\.writeTarget as any\);/g, '// @ts-ignore\n    renderer.setRenderTarget(this.writeTarget as any);');
fs.writeFileSync('src/entities/water/simulation/RippleSimulation.ts', code);
