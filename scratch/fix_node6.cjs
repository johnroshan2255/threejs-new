const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

// Replace the duplicate createFireflies on line 111 (which is index 110)
// We'll just do a regex to replace two exact same imports
code = code.replace(/import \{ createFireflies, type Fireflies \} from "\.\/environment\/fireflies";[\s\S]*?import \{ createFireflies, type Fireflies \} from "\.\/environment\/fireflies";/, 
`import { createFireflies, type Fireflies } from "./environment/fireflies";\nimport { BombSound } from "./audio/BombSound";`);

fs.writeFileSync('src/main.ts', code, 'utf8');
