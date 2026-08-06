const fs = require('fs');

// Patch dayNightCycle.ts
let sky = fs.readFileSync('src/environment/dayNightCycle.ts', 'utf-8');
sky = sky.replace(/function createSkyMaterial\(\) \{[\s\S]*?\n\}/, `function createSkyMaterial() {
	const mat = new THREE.MeshBasicMaterial({ color: "#4aa0e0", side: THREE.BackSide, depthWrite: false, fog: false }) as any;
	mat.uniforms = {
		uSunDir: { value: new THREE.Vector3(0, 1, 0) },
		uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
		uZenith: { value: new THREE.Color("#4aa0e0") },
		uHorizon: { value: new THREE.Color("#c8e4f5") },
		uSunColor: { value: new THREE.Color("#fff5e0") },
		uMoonColor: { value: new THREE.Color("#c4d4ff") },
		uSunGlow: { value: 1 },
		uSunIntensity: { value: 1 },
		uMoonIntensity: { value: 0 },
		uTime: { value: 0 },
		uCloudCoverage: { value: 0.45 },
		uCloudOpacity: { value: 0.85 },
		uCloudLight: { value: new THREE.Color("#ffffff") },
		uCloudDark: { value: new THREE.Color("#c6d6ea") },
		uCloudScale: { value: 0.65 },
		uCloudSpeed: { value: 1 }
	};
	return mat;
}`);
fs.writeFileSync('src/environment/dayNightCycle.ts', sky);

// Patch toonCharacter.ts
let toon = fs.readFileSync('src/entities/human/toonCharacter.ts', 'utf-8');
toon = toon.replace(/function createOutlineMaterial\(color: THREE\.ColorRepresentation\) \{[\s\S]*?\n\}/, `function createOutlineMaterial(color: THREE.ColorRepresentation) {
	const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, depthWrite: true }) as any;
	mat.uniforms = {
		uOutlineWidth: { value: 0 },
		uRefDistance: { value: 0 },
		uMinScale: { value: 0 },
		uResolution: { value: new THREE.Vector2() },
		uOutlineColor: { value: new THREE.Color(color) }
	};
	return mat;
}`);
fs.writeFileSync('src/entities/human/toonCharacter.ts', toon);
