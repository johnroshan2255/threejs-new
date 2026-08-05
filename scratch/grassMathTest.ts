import * as THREE from "three";
import {
	buildGrassPlacement,
	writeBladeMatrix,
} from "../src/entities/grass/grassPlacementCore";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// ------------------------------------------------- matrix math vs THREE
// The worker cannot import THREE, so the blade matrix is written longhand.
// It has to agree with THREE element-for-element or every blade is subtly wrong.
const yAxis = new THREE.Vector3(0, 1, 0);
const q = new THREE.Quaternion();
const spin = new THREE.Quaternion();
const m4 = new THREE.Matrix4();
const mine = new Float32Array(16);

const normals: THREE.Vector3[] = [
	new THREE.Vector3(0, 1, 0),
	new THREE.Vector3(0.3, 0.9, -0.2).normalize(),
	new THREE.Vector3(-0.6, 0.5, 0.62).normalize(),
	new THREE.Vector3(0.99, 0.14, 0).normalize(),
	new THREE.Vector3(0, -1, 0), // antiparallel edge case
];
const yaws = [0, 0.7, Math.PI, 4.2, Math.PI * 2 - 0.01];
const scales = [
	[1, 1, 1],
	[0.83, 0.42, 0.83],
	[1.19, 1.4, 1.19],
];

let worst = 0;
let worstWhere = "";
for (const n of normals) {
	for (const yaw of yaws) {
		for (const [sx, sy, sz] of scales) {
			q.setFromUnitVectors(yAxis, n);
			spin.setFromEuler(new THREE.Euler(0, yaw, 0));
			const composed = q.clone().multiply(spin);
			m4.compose(
				new THREE.Vector3(3, -2, 7),
				composed,
				new THREE.Vector3(sx!, sy!, sz!)
			);

			writeBladeMatrix(mine, 0, 3, -2, 7, n.x, n.y, n.z, yaw, sx!, sy!, sz!);

			for (let i = 0; i < 16; i++) {
				const d = Math.abs(mine[i]! - m4.elements[i]!);
				if (d > worst) {
					worst = d;
					worstWhere = `n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(
						2
					)}) yaw=${yaw.toFixed(2)} el[${i}]`;
				}
			}
		}
	}
}
check(
	"blade matrix matches THREE for all normals / yaws / scales",
	worst < 1e-6,
	`max element delta ${worst.toExponential(2)}${worstWhere ? ` at ${worstWhere}` : ""}`
);

// ------------------------------------------------------- placement sanity
const segs = 64;
const size = 200;
const heights = new Float32Array((segs + 1) * (segs + 1));
for (let col = 0; col <= segs; col++) {
	for (let row = 0; row <= segs; row++) {
		const x = -size / 2 + (col / segs) * size;
		const z = -size / 2 + (row / segs) * size;
		heights[row + col * (segs + 1)] =
			4 * Math.sin(x * 0.05) * Math.cos(z * 0.04);
	}
}

const spacing = Math.sqrt(1 / 1.2);
const result = buildGrassPlacement({
	heights,
	nrows: segs,
	ncols: segs,
	size,
	spacing,
	keepProb: 1,
	maxCount: 60000,
	minNormalY: Math.cos((65 * Math.PI) / 180),
	chunkSize: 15,
	heightMultiplier: 0.6,
	clearPondHole: false,
	pondX: 0,
	pondZ: 0,
});

check("produced blades", result.total > 10000, `${result.total} blades`);
check("respected the budget", result.total <= 60000, `${result.total}`);
check("produced chunks", result.chunks.length > 10, `${result.chunks.length} chunks`);
check(
	"chunk counts sum to total",
	result.chunks.reduce((a, c) => a + c.count, 0) === result.total
);
check(
	"every chunk buffer is exactly count * 16",
	result.chunks.every((c) => c.matrices.length === c.count * 16)
);

// Blades must sit on the interpolated surface, not the nearest vertex.
const half = size * 0.5;
const stride = segs + 1;
const sampleH = (x: number, z: number) => {
	const fx = Math.min(Math.max(((x + half) / size) * segs, 0), segs);
	const fz = Math.min(Math.max(((z + half) / size) * segs, 0), segs);
	const c0 = Math.floor(fx);
	const r0 = Math.floor(fz);
	const c1 = Math.min(c0 + 1, segs);
	const r1 = Math.min(r0 + 1, segs);
	const tx = fx - c0;
	const tz = fz - r0;
	const h00 = heights[r0 + c0 * stride]!;
	const h10 = heights[r0 + c1 * stride]!;
	const h01 = heights[r1 + c0 * stride]!;
	const h11 = heights[r1 + c1 * stride]!;
	return (
		h00 + (h10 - h00) * tx + (h01 + (h11 - h01) * tx - (h00 + (h10 - h00) * tx)) * tz
	);
};

let offSurface = 0;
let outsideChunk = 0;
let badScale = 0;
const pos = new THREE.Vector3();
const rot = new THREE.Quaternion();
const scl = new THREE.Vector3();
for (const chunk of result.chunks) {
	for (let i = 0; i < chunk.count; i++) {
		m4.fromArray(chunk.matrices, i * 16);
		m4.decompose(pos, rot, scl);
		if (Math.abs(pos.y - sampleH(pos.x, pos.z)) > 1e-3) offSurface++;
		if (
			Math.floor(pos.x / 15) !== Math.floor(chunk.centerX / 15) &&
			Math.abs(pos.x - chunk.centerX) > 15
		) {
			outsideChunk++;
		}
		// X/Z carry only the 0.8–1.2 variation; Y also carries the 0.6 multiplier.
		if (scl.x < 0.79 || scl.x > 1.21) badScale++;
		if (scl.y < 0.79 * 0.6 - 1e-4 || scl.y > 1.21 * 0.6 + 1e-4) badScale++;
	}
}
check("all blades sit on the bilinear surface", offSurface === 0, `${offSurface} off`);
check("blades stay within their chunk", outsideChunk === 0, `${outsideChunk} stray`);
check("scales in expected range (Y carries height multiplier)", badScale === 0, `${badScale} bad`);

// Bounds must enclose every instance, or frustum culling pops chunks.
let boundsViolations = 0;
for (const chunk of result.chunks) {
	for (let i = 0; i < chunk.count; i++) {
		m4.fromArray(chunk.matrices, i * 16);
		m4.decompose(pos, rot, scl);
		if (
			pos.x < chunk.minX ||
			pos.x > chunk.maxX ||
			pos.y < chunk.minY ||
			pos.y > chunk.maxY ||
			pos.z < chunk.minZ ||
			pos.z > chunk.maxZ
		) {
			boundsViolations++;
		}
	}
}
check("reported chunk bounds enclose every instance", boundsViolations === 0, `${boundsViolations}`);

// Slope rejection must actually bite on steep ground.
const steep = new Float32Array((segs + 1) * (segs + 1));
for (let col = 0; col <= segs; col++) {
	for (let row = 0; row <= segs; row++) {
		steep[row + col * (segs + 1)] = col * 40; // ~cliff
	}
}
const steepResult = buildGrassPlacement({
	heights: steep,
	nrows: segs,
	ncols: segs,
	size,
	spacing,
	keepProb: 1,
	maxCount: 60000,
	minNormalY: Math.cos((65 * Math.PI) / 180),
	chunkSize: 15,
	heightMultiplier: 0.6,
	clearPondHole: false,
	pondX: 0,
	pondZ: 0,
});
check("slope limit rejects cliffs", steepResult.total === 0, `${steepResult.total} blades`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
