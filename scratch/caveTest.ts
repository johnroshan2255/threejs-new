import * as THREE from "three";
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

import { buildCaveGeometry, punchTerrainHoles } from "../src/terrain/caveMesh";
import { caveDistance, createHeightSampler } from "../src/terrain/caveShape";

/** Zero-height grid for the flat-ground cases. */
function flatHeights(segments: number) {
	return new Float32Array((segments + 1) * (segments + 1));
}

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

// ---------------------------------------------------------------- flat ground
const flat = () => 0;
const nodes = [
	{ x: 0, y: -0.7, z: 0, r: 2 },
	{ x: 0, y: -6, z: 10, r: 2.5 },
	{ x: 0, y: -6, z: 20, r: 2 },
];

const built = buildCaveGeometry({
	nodes,
	heights: flatHeights(200),
	nrows: 200,
	ncols: 200,
	size: 100,
});
check("builds geometry", !!built);
if (!built) {
	process.exit(1);
}
console.log(
	`      voxel=${built.voxelSize.toFixed(3)}m tris=${built.triangles} ` +
		`bounds=${built.bounds.min.toArray().map((v) => v.toFixed(1))} → ${built.bounds.max
			.toArray()
			.map((v) => v.toFixed(1))}`
);
check("triangle count is plausible", built.triangles > 2000, `${built.triangles} tris`);
check("voxel stayed at target", Math.abs(built.voxelSize - 0.25) < 1e-6, `${built.voxelSize}`);

const mesh = new THREE.Mesh(built.geometry, new THREE.MeshBasicMaterial());
mesh.updateMatrixWorld(true);
const ray = new THREE.Raycaster();
ray.far = 200;

function cast(from: THREE.Vector3, dir: THREE.Vector3) {
	ray.set(from, dir.clone().normalize());
	return ray.intersectObject(mesh, false);
}

// -------------------------------------------------- tunnel is hollow + sealed
const insidePt = new THREE.Vector3(0, -6, 15);
check(
	"probe point really is inside the void",
	caveDistance(nodes, insidePt.x, insidePt.y, insidePt.z) < 0,
	`sdf=${caveDistance(nodes, insidePt.x, insidePt.y, insidePt.z).toFixed(2)}`
);

const down = cast(insidePt, new THREE.Vector3(0, -1, 0));
check("floor exists below tunnel centre", down.length > 0);
if (down.length) {
	const y = down[0]!.point.y;
	// Node at z=20 has r=2, at z=10 r=2.5 — interpolated floor near z=15 ≈ -8.2.
	check("floor depth matches tunnel radius", y < -7.5 && y > -9.0, `y=${y.toFixed(2)}`);
	const n = down[0]!.face!.normal;
	check("floor normal points up out of the rock", n.y > 0.5, `n.y=${n.y.toFixed(2)}`);
}

const up = cast(insidePt, new THREE.Vector3(0, 1, 0));
check("ceiling exists above tunnel centre", up.length > 0);
if (up.length) {
	const y = up[0]!.point.y;
	check("ceiling height matches tunnel radius", y > -4.9 && y < -3.4, `y=${y.toFixed(2)}`);
	check(
		"ceiling normal points down out of the rock",
		up[0]!.face!.normal.y < -0.5,
		`n.y=${up[0]!.face!.normal.y.toFixed(2)}`
	);
}

// Dead end at z=20 must be capped, or players fall out of the world.
const far = cast(insidePt, new THREE.Vector3(0, 0, 1));
check("tunnel dead end is sealed", far.length > 0, `hits=${far.length}`);
if (far.length) {
	check(
		"dead end sits past the last node",
		far[0]!.point.z > 20,
		`z=${far[0]!.point.z.toFixed(2)}`
	);
}

const side = cast(insidePt, new THREE.Vector3(1, 0, 0));
check("tunnel wall is sealed sideways", side.length > 0);

// ------------------------------------------------------------ mouth is open
const aboveMouth = new THREE.Vector3(0, 20, 0);
const mouthHits = cast(aboveMouth, new THREE.Vector3(0, -1, 0));
check("mouth is not capped by shell geometry", mouthHits.length > 0);
if (mouthHits.length) {
	const y = mouthHits[0]!.point.y;
	// The mouth column is void down to the node-0 floor (-0.7 - 2 = -2.7), so the
	// first hit must be well BELOW the ground plane, not at y≈0.
	check("first hit is inside the tunnel, not at ground level", y < -1.5, `y=${y.toFixed(2)}`);
}

// --------------------------------------------------- surface duplicate cull
// Far from the mouth but still inside the padded region, the shell must NOT
// re-state the terrain surface (that would z-fight the terrain plane).
const offMouth = new THREE.Vector3(0, 20, 14);
const offHits = cast(offMouth, new THREE.Vector3(0, -1, 0));
const nearGround = offHits.filter((h) => Math.abs(h.point.y) < 0.4);
check(
	"no duplicate terrain surface away from the mouth",
	nearGround.length === 0,
	`${nearGround.length} hits near y=0`
);

// ------------------------------------------------------------ lip is welded
// Invariant: every vertex classified as terrain-surface must sit exactly on the
// heightfield. Cave-wall vertices are free to be anywhere.
const pos = built.geometry.attributes.position as THREE.BufferAttribute;
let unwelded = 0;
let worstLip = 0;
for (let i = 0; i < pos.count; i++) {
	const x = pos.getX(i);
	const y = pos.getY(i);
	const z = pos.getZ(i);
	const isSurfaceVert = y - flat() >= -caveDistance(nodes, x, y, z);
	// Apron verts sit a deliberate 2mm below the plane to avoid coplanar z-fight.
	if (isSurfaceVert && Math.abs(y - flat()) > 0.003) {
		unwelded++;
		worstLip = Math.max(worstLip, Math.abs(y));
	}
}
check(
	"every terrain-surface vertex is welded onto the heightfield",
	unwelded === 0,
	`${unwelded} unwelded (worst ${worstLip.toFixed(4)}m)`
);

// ------------------------------------------------------------- hole punching
const terrain = new THREE.PlaneGeometry(100, 100, 200, 200);
terrain.rotateX(-Math.PI / 2);
const baseTris = terrain.getIndex()!.count / 3;
const removed = punchTerrainHoles(terrain, [{ nodes }], flat);
check("punch removed triangles", removed > 0, `${removed} of ${baseTris}`);
check("punch left the rest intact", terrain.getIndex()!.count / 3 === baseTris - removed);
// Only the mouth (a ~2m disc near origin) should go, not the whole tunnel run.
check("punch is tight around the mouth", removed < baseTris * 0.01, `${removed} tris`);

// ------------------------------------------- no daylight gap at the seam
// The strongest seam test: over the whole mouth neighbourhood, punched terrain
// plus shell must together cover every column. A crack shows up as a column
// where a downward ray hits nothing at all.
const terrainMesh = new THREE.Mesh(terrain, new THREE.MeshBasicMaterial());
terrainMesh.updateMatrixWorld(true);

// Terrain alone must have an actual opening at the mouth, or nobody gets in.
ray.set(new THREE.Vector3(0, 40, 0), new THREE.Vector3(0, -1, 0));
check(
	"terrain alone is open at the mouth centre",
	ray.intersectObject(terrainMesh, false).length === 0
);
let emptyColumns = 0;
let firstEmpty = "";
for (let gx = -8; gx <= 8; gx += 0.2) {
	for (let gz = -8; gz <= 8; gz += 0.2) {
		ray.set(new THREE.Vector3(gx, 40, gz), new THREE.Vector3(0, -1, 0));
		const hits = ray.intersectObjects([terrainMesh, mesh], false);
		if (hits.length === 0) {
			emptyColumns++;
			if (!firstEmpty) firstEmpty = `(${gx.toFixed(1)}, ${gz.toFixed(1)})`;
		}
	}
}
check(
	"terrain + shell cover every column around the mouth (no crack)",
	emptyColumns === 0,
	`${emptyColumns} empty columns${firstEmpty ? ` first at ${firstEmpty}` : ""}`
);

// ------------------------------------------------------- sculpted (non-flat)
const segs = 64;
const size = 100;
const heights = new Float32Array((segs + 1) * (segs + 1));
for (let col = 0; col <= segs; col++) {
	for (let row = 0; row <= segs; row++) {
		const x = -size / 2 + (col / segs) * size;
		heights[row + col * (segs + 1)] = 6 * Math.exp(-(x * x) / 400);
	}
}
const hillSampler = createHeightSampler(heights, segs, segs, size);
const hillNodes = [
	{ x: -12, y: hillSampler(-12, 0) - 0.6, z: 0, r: 1.8 },
	{ x: 0, y: hillSampler(0, 0) - 7, z: 0, r: 2.2 },
	{ x: 12, y: hillSampler(12, 0) - 6, z: 0, r: 1.8 },
];
const hillBuilt = buildCaveGeometry({
	nodes: hillNodes,
	heights,
	nrows: segs,
	ncols: segs,
	size,
});
check("builds against a sculpted heightfield", !!hillBuilt, `${hillBuilt?.triangles ?? 0} tris`);

// ------------------------------- coarse worlds (10km map => ~39m cells)
// The tool clamps tunnel radius to cell * 1.3; verify a hole actually opens and
// the seam stays covered at that scale, since the punch drops whole triangles.
for (const [label, worldSize, segments] of [
	["1km world", 1000, 254],
	["10km world", 10000, 254],
] as const) {
	const cell = worldSize / segments;
	const r = Math.max(1.2, cell * 1.3);
	const spine = [
		{ x: 0, y: -r * 0.35, z: 0, r },
		{ x: 0, y: -r * 3, z: r * 6, r },
		{ x: 0, y: -r * 3, z: r * 12, r },
	];
	const plane = new THREE.PlaneGeometry(worldSize, worldSize, segments, segments);
	plane.rotateX(-Math.PI / 2);
	const cut = punchTerrainHoles(plane, [{ nodes: spine }], flat);
	check(`${label}: mouth opens (cell ${cell.toFixed(1)}m, r ${r.toFixed(1)}m)`, cut > 0, `${cut} tris`);

	const shell = buildCaveGeometry({
		nodes: spine,
		heights: flatHeights(segments),
		nrows: segments,
		ncols: segments,
		size: worldSize,
	});
	check(`${label}: shell builds`, !!shell, `${shell?.triangles ?? 0} tris, voxel ${shell?.voxelSize.toFixed(2)}m`);
	if (!shell || cut === 0) continue;

	const pMesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial());
	const sMesh = new THREE.Mesh(shell.geometry, new THREE.MeshBasicMaterial());
	pMesh.updateMatrixWorld(true);
	sMesh.updateMatrixWorld(true);
	let empty = 0;
	const span = r * 4;
	const step = span / 40;
	for (let gx = -span; gx <= span; gx += step) {
		for (let gz = -span; gz <= span; gz += step) {
			ray.set(new THREE.Vector3(gx, worldSize, gz), new THREE.Vector3(0, -1, 0));
			ray.far = worldSize * 2;
			if (ray.intersectObjects([pMesh, sMesh], false).length === 0) empty++;
		}
	}
	check(`${label}: no crack at the seam`, empty === 0, `${empty} empty columns`);
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
