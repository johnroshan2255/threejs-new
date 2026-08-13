import * as THREE from "three";
import {
	Fn,
	If,
	atomicAdd,
	atomicStore,
	atomicLoad,
	cos,
	float,
	fract,
	instanceIndex,
	invocationLocalIndex,
	mat4,
	max,
	sin,
	sqrt,
	storage,
	uint,
	uniform,
	uniformArray,
	vec3,
	vec4,
	workgroupArray,
	workgroupBarrier,
} from "three/tsl";
import {
	StorageBufferAttribute,
	StorageInstancedBufferAttribute,
	IndirectStorageBufferAttribute,
} from "three/webgpu";
import {
	generateGrassChunk,
	GRASS_FLOATS_PER_INSTANCE,
	BLADE_SCALE_Y,
	GRASS_FADE_END,
	type GrassChunkGenParams,
} from "./grassPlacementCore";

const BOUND_PADDING = 4;

export const DEFAULT_GRASS_CULL_DISTANCE = 72;

/**
 * Cull radius ceiling.
 *
 * Was 250 m. The blade shader sinks grass fully out of sight by GRASS_FADE_END, so
 * every metre above that drew buried geometry: more instances, more fill, no pixels.
 * It also sets the ring size, so an honest ceiling keeps the resident set small.
 */
export const MAX_GRASS_CULL_DISTANCE = GRASS_FADE_END + 4;

/** Chunk edge length, metres. */
const CHUNK_SIZE = 15;

/**
 * Ring width in chunks.
 *
 * Has to cover MAX_GRASS_CULL_DISTANCE in every direction from the centre chunk,
 * plus a chunk of slack for jitter pushing blades outside their box:
 *   (RING / 2 - 1) * CHUNK_SIZE >= MAX_GRASS_CULL_DISTANCE
 * 12 gives 75 m of guaranteed coverage for a 72 m radius.
 */
const RING = 12;
const RING_SLOTS = RING * RING;

/**
 * Blades a single chunk slot can hold.
 *
 * A 15 m chunk is 225 m^2, and the lattice tops out at 1 / spacing^2 blades per
 * square metre. At the island's 0.894 m spacing that is 281; the margin absorbs
 * jitter pulling extra cells in from a neighbouring box.
 */
const SLOT_CAPACITY = 320;

/**
 * Chunks generated per update at most.
 *
 * Crossing a chunk boundary diagonally retires two rows at once — 23 slots. Spread
 * over a few frames so a fast car never pays for all of them in one.
 */
const STREAM_BUDGET_PER_UPDATE = 6;

export type GrassStreamFieldOptions = {
	geometry: THREE.BufferGeometry;
	material: THREE.Material;
	origin?: THREE.Vector3;
	density?: number;
	cullDistance?: number;
	/** Placement inputs. `seed` must be identical on every client. */
	gen: Omit<GrassChunkGenParams, "chunkSize">;
};

type MaskCircle = { x: number; z: number; radius: number };

/**
 * Grass as a sliding window of chunks around the player, rather than the whole world.
 *
 * Replaces GrassChunkField, which held every blade in the world resident and tested
 * all of them every other frame: 1.25M blades on a 1 km map, 40 MB in the JS heap,
 * 40 MB of VRAM and 40 MB of storage reads per dispatch, to draw the ~8 k inside the
 * cull radius. The blade count scaled with world *area* while the visible count never
 * moved, so the cost of grass grew with map size for no visual gain — and the
 * `grassCountForSize` caps that kept it bounded did so by making big worlds sparser.
 *
 * Here the resident set is fixed: RING x RING chunk slots, sized to the cull radius.
 * A 200 m island and a 10 km world both hold RING_SLOTS * SLOT_CAPACITY blades.
 *
 * Slot addressing is toroidal — a chunk lives at (chunkX mod RING, chunkZ mod RING).
 * Walking one chunk forward means the column leaving the back and the column entering
 * the front differ by exactly RING, so they map to the *same* slot and the new one
 * simply overwrites the old. Nothing is shifted or copied; the ring is implicit in the
 * modulo.
 *
 * Unused blades in a partly-filled slot are zeroed at BLADE_SCALE_Y, which the culling
 * shader already treats as "masked, drop it" — so slot occupancy needs no side buffer
 * and no extra read.
 */
export class GrassStreamField {
	readonly group = new THREE.Group();

	private density: number;
	private hideDistance = DEFAULT_GRASS_CULL_DISTANCE;

	private grassMesh?: THREE.InstancedMesh;
	private indirectBuffer?: IndirectStorageBufferAttribute;
	private instanceDataBuffer?: StorageBufferAttribute;
	private culledDataBuffer?: StorageInstancedBufferAttribute;
	private cullingComputeNode?: any;
	private resetComputeNode?: any;

	private frustumPlanesUniform?: any;
	private cullPositionUniform: any;
	private densityUniform: any;
	private hideDistanceUniform: any;

	/** RING_SLOTS * SLOT_CAPACITY packed blades. Shared with instanceDataBuffer. */
	private blades!: Float32Array;
	/** Chunk each slot currently holds. INVALID means empty. */
	private slotChunkX = new Int32Array(RING_SLOTS);
	private slotChunkZ = new Int32Array(RING_SLOTS);
	private slotFilled = new Uint8Array(RING_SLOTS);

	private gen!: GrassChunkGenParams;
	private maskCircleList: MaskCircle[] = [];

	private frustum = new THREE.Frustum();
	private projScreenMatrix = new THREE.Matrix4();
	private readonly _localCull = new THREE.Vector3();

	private bufferDirty = false;
	private initialized = false;
	/** False until the ring has been filled once; the first fill ignores the budget. */
	private primed = false;

	constructor(options: GrassStreamFieldOptions) {
		this.density = THREE.MathUtils.clamp(options.density ?? 100, 0, 100);
		this.group.name = "Grass";
		this.group.position.copy(options.origin ?? new THREE.Vector3());

		this.gen = { ...options.gen, chunkSize: CHUNK_SIZE };
		if (options.cullDistance != null) this.setCullDistance(options.cullDistance);

		const totalBlades = RING_SLOTS * SLOT_CAPACITY;
		this.blades = new Float32Array(totalBlades * GRASS_FLOATS_PER_INSTANCE);
		this.slotChunkX.fill(2147483647);
		this.slotChunkZ.fill(2147483647);

		if (!options.geometry.boundingSphere) options.geometry.computeBoundingSphere();
		const bladeReach =
			(options.geometry.boundingSphere?.radius ?? 1) * 1.2 + BOUND_PADDING;

		// 1. Blade storage. Two adjacent vec4s per blade, so one node reads both:
		// element(i*2) is (x, y, z, yaw), element(i*2 + 1) is (nx, nz, scaleXZ, scaleY).
		this.instanceDataBuffer = new StorageBufferAttribute(totalBlades * 2, 4);
		this.instanceDataBuffer.array = this.blades;
		const bladeDataNode = storage(this.instanceDataBuffer, "vec4", totalBlades * 2);

		// 2. Culled matrices.
		//
		// Every resident blade could in principle pass culling, so capacity is exactly
		// the resident count — which also means the tally can never exceed it and the
		// overflow clamp the old field needed is gone.
		this.culledDataBuffer = new StorageInstancedBufferAttribute(totalBlades, 16);
		const culledDataNode = storage(this.culledDataBuffer, "mat4", totalBlades);

		// 3. Indirect draw args: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
		const indexCount = options.geometry.index
			? options.geometry.index.count
			: options.geometry.attributes.position.count;
		this.indirectBuffer = new IndirectStorageBufferAttribute(
			new Uint32Array([indexCount, 0, 0, 0, 0]),
			1
		);
		const indirectNode = storage(this.indirectBuffer, "uint", 5).toAtomic();

		// 4. Uniforms
		this.frustumPlanesUniform = uniformArray([
			new THREE.Vector4(),
			new THREE.Vector4(),
			new THREE.Vector4(),
			new THREE.Vector4(),
			new THREE.Vector4(),
			new THREE.Vector4(),
		]);
		this.cullPositionUniform = uniform(new THREE.Vector3());
		this.densityUniform = uniform(float(this.density / 100.0));
		this.hideDistanceUniform = uniform(float(this.hideDistance));

		// 5. Mesh
		//
		// The ring spans the world, so there is no meaningful static bounding volume;
		// frustumCulled is off and culling is entirely the compute pass's job.
		this.grassMesh = new THREE.InstancedMesh(
			options.geometry,
			options.material,
			totalBlades
		);
		this.grassMesh.name = "GrassGPU";
		this.grassMesh.receiveShadow = true;
		this.grassMesh.frustumCulled = false;
		this.grassMesh.geometry.indirect = this.indirectBuffer;
		this.grassMesh.instanceMatrix = this.culledDataBuffer;
		this.group.add(this.grassMesh);

		// 6a. Reset
		const resetFn = Fn(() => {
			atomicStore(indirectNode.element(1), uint(0));
		});
		this.resetComputeNode = resetFn().compute(1);

		// 6b. Cull + rebuild matrices.
		//
		// Dispatch size is a fixed RING_SLOTS * SLOT_CAPACITY, so there is no varying
		// count and no reliance on the framework's bounds guard — which three disables
		// anyway once a shader contains a barrier (BarrierNode sets
		// allowEarlyReturns = false). Empty slot entries carry scaleY = 0 and fall out
		// of the same test that drops masked blades.
		const cullingFn = Fn(() => {
			const sharedData = workgroupArray("atomic<u32>", 2);

			If(invocationLocalIndex.equal(0), () => {
				// @ts-ignore
				atomicStore(sharedData.element(uint(0)), uint(0));
				// @ts-ignore
				atomicStore(sharedData.element(uint(1)), uint(0));
			});
			workgroupBarrier();

			const index = instanceIndex;
			const bladePos = bladeDataNode.element(index.mul(uint(2)));
			const bladeAux = bladeDataNode.element(index.mul(uint(2)).add(uint(1)));

			const pos = bladePos.xyz;
			const yaw = bladePos.w;
			const nx = bladeAux.x;
			const nz = bladeAux.y;
			const scaleXZ = bladeAux.z;
			const scaleY = bladeAux.w;

			const origin = vec3(this.group.position);
			const worldPos = pos.add(origin);

			const dx = this.cullPositionUniform.x.sub(worldPos.x);
			const dz = this.cullPositionUniform.z.sub(worldPos.z);
			const distSq = dx.mul(dx).add(dz.mul(dz));

			const hideDist = this.hideDistanceUniform;

			// Visibility without early-exit, so barriers stay uniform across the group.
			const isVisible = uint(0).toVar();

			If(
				scaleY
					.greaterThan(float(0))
					.and(distSq.lessThan(hideDist.mul(hideDist))),
				() => {
					const radius = float(bladeReach);

					const p0 = this.frustumPlanesUniform.element(0);
					const p1 = this.frustumPlanesUniform.element(1);
					const p2 = this.frustumPlanesUniform.element(2);
					const p3 = this.frustumPlanesUniform.element(3);
					const p4 = this.frustumPlanesUniform.element(4);
					const p5 = this.frustumPlanesUniform.element(5);

					const d0 = p0.x.mul(worldPos.x).add(p0.y.mul(worldPos.y)).add(p0.z.mul(worldPos.z)).add(p0.w);
					const d1 = p1.x.mul(worldPos.x).add(p1.y.mul(worldPos.y)).add(p1.z.mul(worldPos.z)).add(p1.w);
					const d2 = p2.x.mul(worldPos.x).add(p2.y.mul(worldPos.y)).add(p2.z.mul(worldPos.z)).add(p2.w);
					const d3 = p3.x.mul(worldPos.x).add(p3.y.mul(worldPos.y)).add(p3.z.mul(worldPos.z)).add(p3.w);
					const d4 = p4.x.mul(worldPos.x).add(p4.y.mul(worldPos.y)).add(p4.z.mul(worldPos.z)).add(p4.w);
					const d5 = p5.x.mul(worldPos.x).add(p5.y.mul(worldPos.y)).add(p5.z.mul(worldPos.z)).add(p5.w);

					const inFrustum = d0
						.greaterThanEqual(radius.negate())
						.and(d1.greaterThanEqual(radius.negate()))
						.and(d2.greaterThanEqual(radius.negate()))
						.and(d3.greaterThanEqual(radius.negate()))
						.and(d4.greaterThanEqual(radius.negate()))
						.and(d5.greaterThanEqual(radius.negate()));

					If(inFrustum, () => {
						const hash = fract(
							sin(worldPos.x.mul(12.9898).add(worldPos.z.mul(78.233))).mul(43758.5453)
						);
						isVisible.assign(hash.lessThan(this.densityUniform));
					});
				}
			);

			// From here on every thread in the workgroup executes identically. Only the
			// isVisible-gated *work* differs, not control flow around barriers.
			const localOffset = uint(0).toVar();

			If(isVisible, () => {
				// @ts-ignore
				localOffset.assign(atomicAdd(sharedData.element(uint(0)), uint(1)));
			});

			workgroupBarrier();

			If(invocationLocalIndex.equal(0), () => {
				// @ts-ignore
				const totalLocal = atomicLoad(sharedData.element(uint(0)));
				// @ts-ignore
				If(totalLocal.greaterThan(uint(0)), () => {
					// @ts-ignore — one line so the suppression covers `.element`
					atomicStore(sharedData.element(uint(1)), atomicAdd(indirectNode.element(1), totalLocal));
				});
			});

			workgroupBarrier();

			If(isVisible, () => {
				// @ts-ignore
				const writeIndex = atomicLoad(sharedData.element(uint(1))).add(localOffset);

				// Rebuild the instance matrix from the packed blade.
				//
				// Line-for-line the same math as `writeBladeMatrix` in
				// grassPlacementCore, which is verified element-wise against THREE in
				// scratch/grassMathTest.ts. Keep the two in step: nothing checks this
				// TSL against that reference automatically.
				//
				// `ny` is recovered rather than stored — placement rejects any ground
				// steeper than 65 degrees, so the normal always points up.
				const ny = sqrt(max(float(0), float(1).sub(nx.mul(nx)).sub(nz.mul(nz))));

				// quaternion.setFromUnitVectors((0,1,0), n), with qy == 0.
				const qx = nz;
				const qz = nx.negate();
				const qw = ny.add(float(1));
				const ql = max(sqrt(qx.mul(qx).add(qz.mul(qz)).add(qw.mul(qw))), float(1e-6));
				const ux = qx.div(ql);
				const uz = qz.div(ql);
				const uw = qw.div(ql);

				// ...multiplied by a spin about Y. qy == 0 collapses two terms.
				const s = sin(yaw.mul(float(0.5)));
				const c = cos(yaw.mul(float(0.5)));
				const rx = ux.mul(c).sub(uz.mul(s));
				const ry = uw.mul(s);
				const rz = uz.mul(c).add(ux.mul(s));
				const rw = uw.mul(c);

				const x2 = rx.add(rx);
				const y2 = ry.add(ry);
				const z2 = rz.add(rz);
				const xx = rx.mul(x2);
				const xy = rx.mul(y2);
				const xz = rx.mul(z2);
				const yy = ry.mul(y2);
				const yz = ry.mul(z2);
				const zz = rz.mul(z2);
				const wx = rw.mul(x2);
				const wy = rw.mul(y2);
				const wz = rw.mul(z2);

				const one = float(1);
				culledDataNode.element(writeIndex).assign(
					mat4(
						vec4(
							one.sub(yy.add(zz)).mul(scaleXZ),
							xy.add(wz).mul(scaleXZ),
							xz.sub(wy).mul(scaleXZ),
							float(0)
						),
						vec4(
							xy.sub(wz).mul(scaleY),
							one.sub(xx.add(zz)).mul(scaleY),
							yz.add(wx).mul(scaleY),
							float(0)
						),
						vec4(
							xz.add(wy).mul(scaleXZ),
							yz.sub(wx).mul(scaleXZ),
							one.sub(xx.add(yy)).mul(scaleXZ),
							float(0)
						),
						vec4(pos.x, pos.y, pos.z, float(1))
					)
				);
			});
		});

		this.cullingComputeNode = cullingFn().compute(totalBlades);
		this.initialized = true;
	}

	// ------------------------------------------------------------------ settings

	setDensity(percent: number) {
		this.density = THREE.MathUtils.clamp(percent, 0, 100);
		if (this.densityUniform) this.densityUniform.value = this.density / 100.0;
	}

	setCullDistance(meters: number) {
		// Clamped to what the ring covers *and* to what the blade shader can show.
		const hide = THREE.MathUtils.clamp(meters, 30, MAX_GRASS_CULL_DISTANCE);
		this.hideDistance = hide;
		if (this.hideDistanceUniform) this.hideDistanceUniform.value = hide;
	}

	get cullDistance() {
		return this.hideDistance;
	}

	// ------------------------------------------------------------------ streaming

	/**
	 * Bring the ring up to date around `cullPos`, generating at most
	 * STREAM_BUDGET_PER_UPDATE chunks.
	 *
	 * Slots are visited nearest-first so that when the budget bites, the chunks the
	 * player is about to see are the ones that got filled.
	 */
	private streamAround(cullPos: THREE.Vector3) {
		this._localCull.copy(cullPos).sub(this.group.position);
		const centreX = Math.floor(this._localCull.x / CHUNK_SIZE);
		const centreZ = Math.floor(this._localCull.z / CHUNK_SIZE);

		const half = RING >> 1;

		// The first fill ignores the budget. Trickling 144 chunks in at
		// STREAM_BUDGET_PER_UPDATE would take ~50 frames, which reads as grass growing
		// in around the player on spawn. The whole ring is only ~40k blades — a few ms
		// once, against a world load that already takes far longer.
		let budget = this.primed ? STREAM_BUDGET_PER_UPDATE : RING_SLOTS;
		this.primed = true;

		// Nearest-first over the ring's chunk offsets, so when the budget bites it is
		// the far shells that wait.
		//
		// Offsets run [-half, half - 1], NOT [-half, half]. Those two ends differ by
		// exactly RING and so address the *same* slot: including both makes two chunk
		// coordinates claim one slot, and they overwrite each other every single update,
		// burning the whole budget forever on two chunks that never stay filled.
		// [-6, +5] still guarantees 75 m of coverage for a 72 m cull radius, worst case
		// with the player against the far edge of the centre chunk.
		const lo = -half;
		const hi = half - 1;
		for (let ring = 0; ring <= half && budget > 0; ring++) {
			for (let dz = Math.max(-ring, lo); dz <= Math.min(ring, hi) && budget > 0; dz++) {
				for (let dx = Math.max(-ring, lo); dx <= Math.min(ring, hi) && budget > 0; dx++) {
					// Only the shell at this radius; inner shells were done already.
					if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;

					const chunkX = centreX + dx;
					const chunkZ = centreZ + dz;
					const slot = this.slotIndex(chunkX, chunkZ);

					if (
						this.slotFilled[slot] === 1 &&
						this.slotChunkX[slot] === chunkX &&
						this.slotChunkZ[slot] === chunkZ
					) {
						continue;
					}

					this.fillSlot(slot, chunkX, chunkZ);
					budget--;
				}
			}
		}
	}

	/**
	 * Toroidal slot address. This is what makes the window slide for free: the column
	 * leaving the back and the column entering the front are RING apart, so they land
	 * on the same slot and the new chunk overwrites the old in place.
	 */
	private slotIndex(chunkX: number, chunkZ: number) {
		const sx = ((chunkX % RING) + RING) % RING;
		const sz = ((chunkZ % RING) + RING) % RING;
		return sz * RING + sx;
	}

	private fillSlot(slot: number, chunkX: number, chunkZ: number) {
		const base = slot * SLOT_CAPACITY * GRASS_FLOATS_PER_INSTANCE;
		const written = generateGrassChunk(
			this.gen,
			chunkX,
			chunkZ,
			this.blades,
			base,
			SLOT_CAPACITY
		);

		if (this.maskCircleList.length > 0) {
			this.applyMaskToSlot(base, written);
		}

		// Zero the Y scale of the unused tail. The culling shader drops those on the
		// same test that drops masked blades, so occupancy needs no side buffer.
		for (let i = written; i < SLOT_CAPACITY; i++) {
			this.blades[base + i * GRASS_FLOATS_PER_INSTANCE + BLADE_SCALE_Y] = 0;
		}

		this.slotChunkX[slot] = chunkX;
		this.slotChunkZ[slot] = chunkZ;
		this.slotFilled[slot] = 1;
		this.bufferDirty = true;
	}

	// ---------------------------------------------------------------------- masks

	/**
	 * Replace the mask set (roads, paths) and invalidate whatever it touches.
	 *
	 * Masks are kept as circles rather than baked into the buffer, because a streamed
	 * chunk is regenerated from scratch whenever it re-enters the ring and would
	 * otherwise come back unmasked. This is also what makes edit sync work: an op
	 * arriving from another player is just another circle, and only the slots it
	 * overlaps are rebuilt.
	 */
	setMaskCircles(circles: MaskCircle[]) {
		this.maskCircleList = circles.slice();
		this.invalidateAll();
	}

	addMaskCircles(circles: MaskCircle[]) {
		if (!circles.length) return;
		for (const c of circles) this.maskCircleList.push(c);
		for (const c of circles) this.invalidateAround(c);
	}

	/**
	 * Signature-compatible with GrassChunkField so the editor's call sites are
	 * unchanged. Async is now vestigial — masking is a few array writes against the
	 * resident ring rather than a pass over every blade in the world, so there is
	 * nothing to hand to a worker.
	 */
	async maskRoadCircle(worldX: number, worldZ: number, radius: number) {
		this.addMaskCircles([{ x: worldX, z: worldZ, radius }]);
	}

	async maskCircles(circles: MaskCircle[]) {
		this.addMaskCircles(circles);
	}

	clearMask() {
		if (!this.maskCircleList.length) return;
		this.maskCircleList = [];
		this.invalidateAll();
	}

	private applyMaskToSlot(base: number, written: number) {
		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		for (let i = 0; i < written; i++) {
			const offset = base + i * GRASS_FLOATS_PER_INSTANCE;
			const x = this.blades[offset]!;
			const z = this.blades[offset + 2]!;
			for (const c of this.maskCircleList) {
				const dx = x - (c.x - originX);
				const dz = z - (c.z - originZ);
				if (dx * dx + dz * dz <= c.radius * c.radius) {
					this.blades[offset + BLADE_SCALE_Y] = 0;
					break;
				}
			}
		}
	}

	/** Drop every slot so the ring refills from the current generation inputs. */
	private invalidateAll() {
		this.slotFilled.fill(0);
	}

	private invalidateAround(circle: MaskCircle) {
		const originX = this.group.position.x;
		const originZ = this.group.position.z;
		const localX = circle.x - originX;
		const localZ = circle.z - originZ;
		const r = circle.radius + CHUNK_SIZE;
		const minCX = Math.floor((localX - r) / CHUNK_SIZE);
		const maxCX = Math.floor((localX + r) / CHUNK_SIZE);
		const minCZ = Math.floor((localZ - r) / CHUNK_SIZE);
		const maxCZ = Math.floor((localZ + r) / CHUNK_SIZE);
		for (let cz = minCZ; cz <= maxCZ; cz++) {
			for (let cx = minCX; cx <= maxCX; cx++) {
				const slot = this.slotIndex(cx, cz);
				if (this.slotChunkX[slot] === cx && this.slotChunkZ[slot] === cz) {
					this.slotFilled[slot] = 0;
				}
			}
		}
	}

	/**
	 * Terrain changed (a sculpt stroke, or an edit synced from another player) — drop
	 * the slots over that area so they regenerate against the new heights.
	 *
	 * The whole-field rebuild this replaces was the worst stall in edit mode: it
	 * regenerated every blade in the world after each stroke.
	 */
	invalidateArea(worldX: number, worldZ: number, radius: number) {
		this.invalidateAround({ x: worldX, z: worldZ, radius });
	}

	/** Heights were replaced wholesale (world load, or a large sculpt). */
	setHeights(heights: Float32Array) {
		this.gen = { ...this.gen, heights };
		this.invalidateAll();
	}

	// ----------------------------------------------------------------- per frame

	updateCompute(renderer: any, camera: THREE.Camera, cullPos: THREE.Vector3) {
		if (!this.initialized) return;

		this.streamAround(cullPos);

		if (this.bufferDirty && this.instanceDataBuffer) {
			// Whole-buffer upload. At RING_SLOTS * SLOT_CAPACITY blades this is ~1.5 MB
			// and only happens on frames where a chunk actually changed, so the partial
			// update ranges are not worth the bookkeeping.
			this.instanceDataBuffer.needsUpdate = true;
			this.bufferDirty = false;
		}

		this.cullPositionUniform.value.copy(cullPos);

		this.projScreenMatrix.multiplyMatrices(
			camera.projectionMatrix,
			camera.matrixWorldInverse
		);
		this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
		for (let i = 0; i < 6; i++) {
			const plane = this.frustum.planes[i];
			this.frustumPlanesUniform.array[i].set(
				plane.normal.x,
				plane.normal.y,
				plane.normal.z,
				plane.constant
			);
		}

		renderer.compute(this.resetComputeNode);
		renderer.compute(this.cullingComputeNode);
	}

	/** Kept for call-site compatibility; the ring handles distance itself. */
	updateDistanceCulling(_focusPosition: THREE.Vector3) {}

	// ------------------------------------------------------------------- teardown

	/**
	 * `renderer` is required to actually free the storage buffers. Calling
	 * `BufferAttribute.dispose()` on them does nothing: it only dispatches a 'dispose'
	 * event, and in three 0.185 nothing listens to that for a standalone storage
	 * attribute — `Attributes.delete()` is reached only from `Geometries.js`, i.e. for
	 * buffers a geometry owns. These three are created loose, so the backend keeps
	 * every one of them for the lifetime of the page otherwise.
	 */
	dispose(renderer?: any) {
		this.group.removeFromParent();
		this.grassMesh?.geometry.dispose();
		this.grassMesh?.dispose();

		const cache = renderer?._attributes;
		const release = (attr?: THREE.BufferAttribute) => {
			if (!attr) return;
			if (cache) cache.delete(attr);
			else attr.dispose();
		};
		release(this.indirectBuffer);
		release(this.instanceDataBuffer);
		release(this.culledDataBuffer);
		this.group.clear();

		// Drop the compute graphs too: they reference the buffers above, and holding
		// them keeps the whole node chain — and its bindings — alive.
		this.cullingComputeNode = undefined;
		this.resetComputeNode = undefined;
		this.indirectBuffer = undefined;
		this.instanceDataBuffer = undefined;
		this.culledDataBuffer = undefined;
		this.initialized = false;
	}
}
