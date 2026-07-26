const THREE = require("three");

const _carPos = new THREE.Vector3(0, 0, 0);
const _forward = new THREE.Vector3(0, 0, -1);
const horizDist = 8;
const lift = 2;
const CAM_HEIGHT = 2.8;

function testCam(inputYaw) {
    const carYaw = Math.atan2(_forward.x, _forward.z);
    const camYaw = carYaw + inputYaw;

    const _targetCam = new THREE.Vector3();
    _targetCam.set(
        _carPos.x - Math.sin(camYaw) * horizDist,
        _carPos.y + lift + CAM_HEIGHT,
        _carPos.z - Math.cos(camYaw) * horizDist
    );
    
    console.log(`Input Yaw: ${inputYaw}`);
    console.log(`Target Cam:`, _targetCam);
}

testCam(0);
testCam(Math.PI);
