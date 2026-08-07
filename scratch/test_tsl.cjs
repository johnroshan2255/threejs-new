const { cameraProjectionMatrix } = require("three/tsl");
console.log(typeof cameraProjectionMatrix);
console.log(Object.keys(cameraProjectionMatrix || {}));
const col1 = cameraProjectionMatrix[1];
console.log(col1);
if (col1) {
    console.log(col1.y);
}
