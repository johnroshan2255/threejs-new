const fs = require('fs');
let code = fs.readFileSync('src/environment/dayNightCycle.ts', 'utf-8');
const createSkyMaterial = `
function createSkyMaterial() {
	const mat = new THREE.MeshBasicMaterial({
		side: THREE.BackSide,
		depthWrite: false,
		fog: false,
		color: "#4aa0e0" // Base sky color for now
	}) as any;
	
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
		uCloudSpeed: { value: 1 },
	};
	return mat;
}
`;
code = code.replace(/function createSkyMaterial\(\) \{[\s\S]*?	\}\);\n\}/, createSkyMaterial.trim());
fs.writeFileSync('src/environment/dayNightCycle.ts', code);
