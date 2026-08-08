import { Fn, vec3, storage, instanceIndex, float, If, Loop, uint, mix } from "three/tsl";
import * as THREE from "three";

export type PaintCircle = {
	x: number;
	z: number;
	radius: number;
	type: "mud" | "water";
};

export async function computePaintTerrain(
	renderer: any,
	mesh: THREE.Mesh,
	circles: PaintCircle[]
) {
	if (circles.length === 0) return;

	const geometry = mesh.geometry as THREE.BufferGeometry;
	const colors = geometry.attributes.color as any;
	const positions = geometry.attributes.position as any;
	
	if (!colors || !colors.isStorageBufferAttribute) {
		console.warn("computePaintTerrain: colors attribute is not a StorageBufferAttribute");
		return;
	}

	const origin = mesh.position;

	// Pack circles into a float array [x, z, radius, type]
	const packedCircles = new Float32Array(circles.length * 4);
	for (let i = 0; i < circles.length; i++) {
		const c = circles[i]!;
		packedCircles[i * 4 + 0] = c.x - origin.x;
		packedCircles[i * 4 + 1] = c.z - origin.z;
		packedCircles[i * 4 + 2] = c.radius;
		packedCircles[i * 4 + 3] = c.type === "mud" ? 0 : 1;
	}

	const { StorageInstancedBufferAttribute } = await import("three/webgpu");
	const circlesBuffer = new StorageInstancedBufferAttribute(packedCircles, 4);

	const computeColorsFn = Fn(() => {
		const pos = storage(positions, 'vec3', positions.count).element(instanceIndex);
		const col = storage(colors, 'vec3', colors.count).element(instanceIndex);
		
		const numCircles = uint(circles.length);
		const circlesData = storage(circlesBuffer, 'vec4', circles.length);

		// Precise sRGB converted to linear
		const _w = new THREE.Color("#7eb8e8");
		const waterColor = vec3(_w.r, _w.g, _w.b);
		const _m = new THREE.Color("#a8906e");
		const mudColor = vec3(_m.r, _m.g, _m.b);
		
		// Create a local var for the color so we can mutate it
		const outColor = vec3(col).toVar();

		Loop({ start: uint(0), end: numCircles }, ({ i }) => {
			const cData = circlesData.element(i);
			const cx = cData.x;
			const cz = cData.y;
			const cr = cData.z;
			const cType = cData.w;

			const dx = pos.x.sub(cx);
			const dz = pos.z.sub(cz);
			const d2 = dx.mul(dx).add(dz.mul(dz));
			const r2 = cr.mul(cr);

			If(d2.lessThanEqual(r2), () => {
				const inv = float(1).div(cr.max(0.0001));
				const dist = d2.pow(0.5);
				const t = float(1).sub(dist.mul(inv));
				// t * t * (3 - 2 * t)
				const w = t.mul(t).mul(float(3).sub(float(2).mul(t)));
				
				const targetColor = vec3(0).toVar();
				If(cType.equal(0), () => {
					targetColor.assign(mudColor);
				}).Else(() => {
					targetColor.assign(waterColor);
				});

				outColor.assign(mix(outColor, targetColor, w));
			});
		});

		col.assign(outColor);
	});

	const computeNode = computeColorsFn().compute(positions.count);
	await renderer.computeAsync(computeNode);
}
