const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

code = code.replace(/if \(\!pass\?\.enabled \|\| \!this\.dayNight\) return;/g, 'if (!this.dayNight) return;');
code = code.replace(/pass\.setParams\(\{[\s\S]*?fogRadiusSoft: PLAYER_FOG_BAND,\n\t\t\}\);/g, '');

fs.writeFileSync('src/main.ts', code, 'utf8');
