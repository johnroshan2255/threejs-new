const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

code = code.replace(/import \{ createFireflies, type Fireflies \} from "\.\/environment\/fireflies";\nimport \{ BombSound \} from "\.\/audio\/BombSound";/, 'import { BombSound } from "./audio/BombSound";');

fs.writeFileSync('src/main.ts', code, 'utf8');
