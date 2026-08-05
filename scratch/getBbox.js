const fs = require('fs');
const obj = fs.readFileSync('c:/Project/threejs-new/public/models/kenney/suv.obj', 'utf-8');

let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

const lines = obj.split('\n');
for (let line of lines) {
    if (line.startsWith('v ')) {
        const parts = line.trim().split(/\s+/);
        const x = parseFloat(parts[1]);
        const y = parseFloat(parts[2]);
        const z = parseFloat(parts[3]);
        
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
}

console.log({ minX, maxX, minY, maxY, minZ, maxZ });
