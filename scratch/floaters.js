/* Floating-object diagnostic. In the browser console run:
 *   await import('/scratch/floaters.js?t=' + Date.now())
 * then copy the printed JSON.
 */
/* Paste-into-console diagnostic: names everything hanging above the ground.
 * No imports — pulls THREE classes off live objects so it works in the console. */
const g = window.__game;
const def = g.activeWorldDef;
const anyVec = g.scene.position;
const V3 = anyVec.constructor;
const Box3 = g.scene.constructor === undefined ? null : null;
const rcHost = g.editMode && g.editMode.raycaster;
const rc = rcHost ? new rcHost.constructor() : null;
const terrain =
	def.kind === "custom"
		? g.customTerrainMesh
		: g.currentWorld === "valley"
			? g.valleyTerrainMesh
			: g.islandTerrainMesh;

const org = new V3();
const down = new V3(0, -1, 0);
const groundAt = (x, z) => {
	if (!rc || !terrain) return null;
	org.set(x, 3000, z);
	rc.set(org, down);
	rc.far = 6000;
	const h = rc.intersectObject(terrain, false);
	return h.length ? h[0].point.y : null;
};

const chainOf = (o) => {
	const parts = [];
	for (let n = o; n; n = n.parent) parts.push(n.name || n.type);
	return parts.join(" < ");
};

// 1. Scene-graph meshes, measured by their own vertex bounds (an object may sit at
//    the origin while its geometry is world-space, e.g. cave shells).
const wp = new V3();
const rows = [];
g.scene.traverse((o) => {
	if (!o.isMesh && !o.isInstancedMesh) return;
	if (/terrain|grass|sky|cloud|firefly|glow|water/i.test(chainOf(o))) return;
	const geo = o.geometry;
	if (!geo || !geo.attributes || !geo.attributes.position) return;
	if (!geo.boundingBox) geo.computeBoundingBox();
	o.updateWorldMatrix(true, false);
	const bb = geo.boundingBox.clone().applyMatrix4(o.matrixWorld);
	const cx = (bb.min.x + bb.max.x) / 2;
	const cz = (bb.min.z + bb.max.z) / 2;
	const gy = groundAt(cx, cz);
	if (gy == null) return;
	const gap = bb.min.y - gy;
	if (gap > 3)
		rows.push({
			what: chainOf(o).slice(0, 70),
			xz: [Math.round(cx), Math.round(cz)],
			bottom: +bb.min.y.toFixed(1),
			ground: +gy.toFixed(1),
			metresUp: +gap.toFixed(1),
			instances: o.isInstancedMesh ? o.count : 1,
		});
});

// 2. The instanced tree manager's master buffer — invisible to any traversal.
const tm = g.treeManager;
const treeRows = [];
if (tm && tm.masterTrunkArray) {
	for (let i = 0; i < tm.count; i++) {
		const x = tm.masterTrunkArray[i * 16 + 12];
		const y = tm.masterTrunkArray[i * 16 + 13];
		const z = tm.masterTrunkArray[i * 16 + 14];
		const gy = groundAt(x, z);
		if (gy == null) continue;
		if (y - gy > 3)
			treeRows.push({ i, xz: [Math.round(x), Math.round(z)], y: +y.toFixed(1), ground: +gy.toFixed(1), metresUp: +(y - gy).toFixed(1) });
	}
}

const report = {
	world: `${g.currentWorld} / ${def.id} / ${def.size}m`,
	terrainColor: g.terrainMat && "#" + g.terrainMat.color.getHexString(),
	vertexColors: g.terrainMat && g.terrainMat.vertexColors,
	grass: {
		island: g.islandGrassField ? g.islandGrassField.allMatrices.length / 16 : null,
		custom: g.customGrassField ? g.customGrassField.allMatrices.length / 16 : null,
		islandVisible: g.islandGrassField ? g.islandGrassField.group.visible : null,
		customVisible: g.customGrassField ? g.customGrassField.group.visible : null,
		density: g.grassDensity,
		cullDistance: g.grassCullDistance,
	},
	counts: {
		treeHandles: (g.trees || []).length,
		instancedTrees: tm ? tm.count : null,
		editorStones: (g.editorStones || []).length,
		editorPonds: (g.editorPonds || []).length,
		scenicProps: (g.islandScenicProps || []).length,
		ops: g.editMode ? g.editMode.store.opCount : null,
		roomCode: g.roomCode || null,
	},
	airborneMeshes: rows.sort((a, b) => b.metresUp - a.metresUp).slice(0, 25),
	airborneInstancedTrees: treeRows.sort((a, b) => b.metresUp - a.metresUp).slice(0, 25),
	airborneMeshCount: rows.length,
	airborneTreeCount: treeRows.length,
};
console.log(JSON.stringify(report, null, 1));
window.__floaterReport = report;
export default report;
