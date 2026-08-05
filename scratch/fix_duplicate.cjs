const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

const target = 'import { createFireflies, type Fireflies } from "./environment/fireflies";';
const parts = code.split(target);
if (parts.length > 2) {
    // Join all parts except the second one with the target, leaving out the duplicate
    code = parts[0] + target + parts[1] + parts.slice(2).join('');
    fs.writeFileSync('src/main.ts', code, 'utf8');
    console.log('Fixed duplicate import');
} else {
    console.log('No duplicate found');
}
