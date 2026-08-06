const fs = require('fs');
let code = fs.readFileSync('src/entities/water/rendering/RefractionPass.ts', 'utf-8');
code = code.replace(/render\([\s\S]*?\): void \{[\s\S]*?\n  \}/, 'render(renderer: any, scene: any, camera: any, waterVisible: { visible: boolean }): void { return; }');
fs.writeFileSync('src/entities/water/rendering/RefractionPass.ts', code);
