const fs = require('fs');
let code = fs.readFileSync('src/entities/human/toonCharacter.ts', 'utf-8');
code = code.replace(/function patchToonShader\(material: THREE\.MeshToonMaterial\) \{[\s\S]*?\n\}/, 'function patchToonShader(material: THREE.MeshToonMaterial) { return; }');
fs.writeFileSync('src/entities/human/toonCharacter.ts', code);
