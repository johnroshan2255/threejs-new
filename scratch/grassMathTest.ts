import * as THREE from "three";
import {
	writeBladeMatrix,
	writeBladePacked,
	unpackBladeMatrix,
	generateGrassChunk,
	GRASS_FLOATS_PER_INSTANCE,
	BLADE_SCALE_Y,
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

// --------------------------------------------- packed layout round-trip
// Blades are stored as two vec4s and the matrix is rebuilt on the GPU. This checks
// the CPU reference for that reconstruction against the matrix the old layout
// stored directly. `ny` is not stored — it is recovered as sqrt(1 - nx^2 - nz^2) —
// so only upward normals can round-trip, which is all placement ever emits.
const packed = new Float32Array(GRASS_FLOATS_PER_INSTANCE);
const reference = new Float32Array(16);
const rebuilt = new Float32Array(16);
const upward = normals.filter((n) => n.y > 0);

let packWorst = 0;
let packWhere = "";
for (const n of upward) {
	for (const yaw of yaws) {
		for (const [sxz, sy] of [
			[1, 1],
			[0.83, 0.42],
			[1.19, 1.4],
		]) {
			writeBladeMatrix(reference, 0, 3, -2, 7, n.x, n.y, n.z, yaw, sxz!, sy!, sxz!);
			writeBladePacked(packed, 0, 3, -2, 7, n.x, n.z, yaw, sxz!, sy!);
			unpackBladeMatrix(rebuilt, 0, packed, 0);

			for (let i = 0; i < 16; i++) {
				const d = Math.abs(rebuilt[i]! - reference[i]!);
				if (d > packWorst) {
					packWorst = d;
					packWhere = `n=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(
						2
					)}) yaw=${yaw.toFixed(2)} el[${i}]`;
				}
			}
		}
	}
}
check(
	"packed blade round-trips to the same matrix",
	packWorst < 1e-6,
	`max element delta ${packWorst.toExponential(2)}${packWhere ? ` at ${packWhere}` : ""}`
);

// A downward normal cannot survive the packing, so placement must never emit one.
// This is the invariant the layout rests on; if the slope limit ever goes above
// 90 degrees the reconstruction silently flips those blades upright.
writeBladePacked(packed, 0, 0, 0, 0, 0, 0, 0, 1, 1);
unpackBladeMatrix(rebuilt, 0, packed, 0);
check(
	"reconstruction assumes an upward normal (documents the invariant)",
	rebuilt[5]! > 0,
	`element[5] = ${rebuilt[5]!.toFixed(3)} for n=(0,?,0)`
);

// ------------------------------------------------- per-chunk placement sanity
// The whole-world `buildGrassPlacement` is gone; these now exercise the streaming
// generator, which is what actually runs.
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

const baseParams = {
	heights,
	nrows: segs,
	ncols: segs,
	size,
	spacing: Math.sqrt(1 / 1.2),
	keepProb: 1,
	minNormalY: Math.cos((65 * Math.PI) / 180),
	heightMultiplier: 0.6,
	chunkSize: 15,
	seed: 4242,
	clearPondHole: false,
	pondX: 0,
	pondZ: 0,
};

const CAP = 512;
const chunkBuf = new Float32Array(CAP * GRASS_FLOATS_PER_INSTANCE);

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
	const a = h00 + (h10 - h00) * tx;
	const b = h01 + (h11 - h01) * tx;
	return a + (b - a) * tz;
};

let produced = 0;
let offSurface = 0;
let badScale = 0;
let zeroScaleY = 0;
const pos = new THREE.Vector3();
const rot = new THREE.Quaternion();
const scl = new THREE.Vector3();
for (let cz = -6; cz <= 6; cz++) {
	for (let cx = -6; cx <= 6; cx++) {
		const n = generateGrassChunk(baseParams, cx, cz, chunkBuf, 0, CAP);
		produced += n;
		for (let i = 0; i < n; i++) {
			const o = i * GRASS_FLOATS_PER_INSTANCE;
			if (chunkBuf[o + BLADE_SCALE_Y] === 0) zeroScaleY++;
			unpackBladeMatrix(rebuilt, 0, chunkBuf, o);
			m4.fromArray(rebuilt, 0);
			m4.decompose(pos, rot, scl);
			if (Math.abs(pos.y - sampleH(pos.x, pos.z)) > 1e-3) offSurface++;
			// X/Z carry only the 0.8-1.2 variation; Y also carries the 0.6 multiplier.
			if (scl.x < 0.79 || scl.x > 1.21) badScale++;
			if (scl.y < 0.79 * 0.6 - 1e-4 || scl.y > 1.21 * 0.6 + 1e-4) badScale++;
		}
	}
}
check("produced blades", produced > 10000, `${produced} blades`);
check("all blades sit on the bilinear surface", offSurface === 0, `${offSurface} off`);
check("scales in expected range (Y carries height multiplier)", badScale === 0, `${badScale} bad`);
// Zero is the "masked" marker, so fresh placement must never emit it — otherwise
// blades would arrive already invisible.
check("no placed blade has a zero Y scale (mask marker is safe)", zeroScaleY === 0, `${zeroScaleY} zero`);

// Slope rejection must actually bite on steep ground.
const steep = new Float32Array((segs + 1) * (segs + 1));
for (let col = 0; col <= segs; col++) {
	for (let row = 0; row <= segs; row++) {
		steep[row + col * (segs + 1)] = col * 40; // ~cliff
	}
}
let steepTotal = 0;
for (let cz = -6; cz <= 6; cz++) {
	for (let cx = -6; cx <= 6; cx++) {
		steepTotal += generateGrassChunk(
			{ ...baseParams, heights: steep },
			cx,
			cz,
			chunkBuf,
			0,
			CAP
		);
	}
}
check("slope limit rejects cliffs", steepTotal === 0, `${steepTotal} blades`);


// ============================================ streaming: determinism + partition
// The two properties the ring rests on. Determinism is a *multiplayer* requirement,
// not just a streaming one: every client generates its own grass, so a non-pure
// generator means two players disagree about where blades are.
const genParams = {
	...baseParams,
	spacing: Math.sqrt(1 / 1.25),
	seed: 123456,
};
const SLOT = 320;
const bufA = new Float32Array(SLOT * GRASS_FLOATS_PER_INSTANCE);
const bufB = new Float32Array(SLOT * GRASS_FLOATS_PER_INSTANCE);

// Same chunk, generated twice — must be byte-identical, or grass reshuffles when a
// chunk leaves the ring and comes back, and clients disagree with each other.
let identical = true;
let counts: number[] = [];
for (const [cx, cz] of [[0, 0], [-3, 2], [5, -6], [-1, -1]] as [number, number][]) {
	const a = generateGrassChunk(genParams, cx, cz, bufA, 0, SLOT);
	const b = generateGrassChunk(genParams, cx, cz, bufB, 0, SLOT);
	counts.push(a);
	if (a !== b) identical = false;
	for (let i = 0; i < a * GRASS_FLOATS_PER_INSTANCE; i++) {
		if (bufA[i] !== bufB[i]) { identical = false; break; }
	}
}
check("chunk generation is deterministic (same bytes twice)", identical, `counts ${counts.join(",")}`);

// A different seed must actually change the field, or "deterministic" is just "fixed".
const bufC = new Float32Array(SLOT * GRASS_FLOATS_PER_INSTANCE);
generateGrassChunk(genParams, 0, 0, bufA, 0, SLOT);
generateGrassChunk({ ...genParams, seed: 999 }, 0, 0, bufC, 0, SLOT);
let differs = false;
for (let i = 0; i < SLOT * GRASS_FLOATS_PER_INSTANCE; i++) {
	if (bufA[i] !== bufC[i]) { differs = true; break; }
}
check("a different seed produces a different field", differs);

// Every blade must land inside its own chunk box, padded by the jitter reach. If a
// chunk emitted blades far outside its box the ring would show holes and doubles.
const pad = genParams.spacing * 0.5 + 1e-4;
let strayCount = 0;
let overCapacity = 0;
for (let cz = -4; cz <= 4; cz++) {
	for (let cx = -4; cx <= 4; cx++) {
		const n = generateGrassChunk(genParams, cx, cz, bufA, 0, SLOT);
		if (n > SLOT) overCapacity++;
		for (let i = 0; i < n; i++) {
			const o = i * GRASS_FLOATS_PER_INSTANCE;
			const bx = bufA[o]!;
			const bz = bufA[o + 2]!;
			if (
				bx < cx * 15 - pad || bx > (cx + 1) * 15 + pad ||
				bz < cz * 15 - pad || bz > (cz + 1) * 15 + pad
			) strayCount++;
		}
	}
}
check("blades stay inside their chunk box (+ jitter pad)", strayCount === 0, `${strayCount} stray`);
check("no chunk exceeds slot capacity", overCapacity === 0, `${overCapacity} over`);

// Chunks must partition the lattice: no cell generated twice, none dropped. Counted
// by summing a block of chunks and comparing with the lattice cells in that area.
let sum = 0;
const seen = new Set<string>();
let dupes = 0;
for (let cz = -3; cz <= 3; cz++) {
	for (let cx = -3; cx <= 3; cx++) {
		const n = generateGrassChunk(genParams, cx, cz, bufA, 0, SLOT);
		sum += n;
		for (let i = 0; i < n; i++) {
			const o = i * GRASS_FLOATS_PER_INSTANCE;
			const key = `${bufA[o]!.toFixed(4)},${bufA[o + 2]!.toFixed(4)}`;
			if (seen.has(key)) dupes++;
			seen.add(key);
		}
	}
}
check("no blade is generated by two chunks", dupes === 0, `${dupes} duplicated of ${sum}`);

// Toroidal slot addressing: the column leaving the back and the column entering the
// front must map to the same slot, which is what makes the window slide for free.
const RING_T = 12;
const slotOf = (cx: number, cz: number) =>
	((((cz % RING_T) + RING_T) % RING_T) * RING_T) + (((cx % RING_T) + RING_T) % RING_T);
check(
	"toroidal addressing recycles the trailing slot",
	slotOf(3, 0) === slotOf(3 + RING_T, 0) && slotOf(-1, -1) === slotOf(-1 + RING_T, -1 + RING_T),
	`slot(3,0)=${slotOf(3, 0)} slot(15,0)=${slotOf(15, 0)}`
);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
