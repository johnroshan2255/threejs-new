const fs = require('fs'); const data = fs.readFileSync('public/poutine.glb', 'utf8'); const matches = data.match(/"name":"([^"]+)"/g); console.log([...new Set(matches)]);
