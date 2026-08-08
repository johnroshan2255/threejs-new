import * as THREE from "three";
import type { PaintCircle } from "./terrainColorCompute";

export function paintTerrainBatch(
	mesh: THREE.Mesh,
	circles: PaintCircle[]
) {
	if (circles.length === 0) return;
	
	const geometry = mesh.geometry as THREE.BufferGeometry;
	const positions = geometry.attributes.position as THREE.BufferAttribute;
	const grass = new THREE.Color("#3f6d21");
	const mud = new THREE.Color("#a8906e");
	const water = new THREE.Color("#7eb8e8");

	if (!geometry.attributes.color) {
		const arr = new Float32Array(positions.count * 3);
		for (let i = 0; i < positions.count; i++) {
			arr[i * 3] = grass.r;
			arr[i * 3 + 1] = grass.g;
			arr[i * 3 + 2] = grass.b;
		}
		geometry.setAttribute("color", new THREE.BufferAttribute(arr, 3));
	}
	const colors = geometry.attributes.color as THREE.BufferAttribute;
	const origin = mesh.position;

	// Optimization: loop over vertices once, check against all circles
	for (let i = 0; i < positions.count; i++) {
		const x = positions.getX(i) + origin.x;
		const z = positions.getZ(i) + origin.z;
		
		let currentR = colors.getX(i);
		let currentG = colors.getY(i);
		let currentB = colors.getZ(i);

		for (const c of circles) {
			const dx = x - c.x;
			const dz = z - c.z;
			const d2 = dx * dx + dz * dz;
			const radiusSq = c.radius * c.radius;
			
			if (d2 <= radiusSq) {
				const inv = 1 / Math.max(c.radius, 0.0001);
				const t = 1 - Math.sqrt(d2) * inv;
				const w = t * t * (3 - 2 * t);
				const target = c.type === "mud" ? mud : water;
				
				currentR = THREE.MathUtils.lerp(currentR, target.r, w);
				currentG = THREE.MathUtils.lerp(currentG, target.g, w);
				currentB = THREE.MathUtils.lerp(currentB, target.b, w);
			}
		}
		
		colors.setXYZ(i, currentR, currentG, currentB);
	}
	
	colors.needsUpdate = true;
}
