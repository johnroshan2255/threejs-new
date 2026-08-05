const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

code = code.replace(/pass\.setParams\(\{[\s\S]*?\}\);/g, '');

fs.writeFileSync('src/main.ts', code, 'utf8');
