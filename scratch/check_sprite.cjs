const fs = require('fs');
const path = require('path');
const file = fs.readFileSync(path.join(__dirname, '../node_modules/three/src/materials/nodes/SpriteNodeMaterial.js'), 'utf8');
console.log(file);
