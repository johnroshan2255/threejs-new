const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

code = code.replace(
    /\\/\\/ this\\.volumetricFogPass\\?\\.setSize\\([\\s\\S]*?\\/\\/ window\\.innerHeight \\* pr\\s*\\);/,
    '// this.volumetricFogPass?.setSize'
);

fs.writeFileSync('src/main.ts', code, 'utf8');
