import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { add, attribute, color, float, Fn, max, mul, positionLocal, sin, uniform } from 'three/tsl';

export type BulletTarget = {
	id: string;
	head: THREE.Vector3;
	spine: THREE.Vector3;
	position: THREE.Vector3;
};

export type BombTarget = {
	id: number;
	position: THREE.Vector3;
};

type Bullet = {
	pos: THREE.Vector3;
	quat: THREE.Quaternion;
	vel: THREE.Vector3;
	prev: THREE.Vector3;
	life: number;
	hitRadius: number;
	/** False for remote visual tracers — no damage / bomb detonation. */
	dealDamage: boolean;
	/** Skip collision with this player (the shooter). */
	ownerId: string | null;
};



/**
 * Visual projectiles with muzzle flash / fire trail.
 * Hits stop the bullet (no pass-through) and fire onHit.
 */
export class BulletSystem {
	public readonly group = new THREE.Group();
	public onHit:
		| ((
				targetId: string,
				point: THREE.Vector3,
				part: "head" | "body"
		  ) => void)
		| null = null;
	public onBombHit: ((bombId: number, point: THREE.Vector3) => void) | null = null;
	public getGroundY: ((x: number, z: number) => number) | null = null;

	private bullets: Bullet[] = [];
	private uTime = uniform(0);

	private static readonly SPEED = 120;
	private static readonly MAX_LIFE = 1.4;
	private static readonly BODY_RADIUS = 0.75;
	private static readonly TORSO_RADIUS = 0.85;
	private static readonly HEAD_RADIUS = 0.45;
	private static readonly BOMB_RADIUS = 0.55;

	private readonly bulletGeo = new THREE.CapsuleGeometry(0.035, 0.22, 4, 8);
	private readonly glowGeo = new THREE.SphereGeometry(0.09, 8, 8);
	private readonly flashGeo = new THREE.SphereGeometry(0.12, 8, 8);
	private readonly impactGeo = new THREE.SphereGeometry(0.1, 8, 8);

	private bulletMat: MeshStandardNodeMaterial;
	private glowMat: MeshBasicNodeMaterial;

	private maxBullets = 150;
	private bulletMesh: THREE.InstancedMesh;
	private glowMesh: THREE.InstancedMesh;

	private flashMesh: THREE.InstancedMesh;
	private flashStartTimes: Float32Array;
	private maxFlashes = 50;
	private flashIdx = 0;

	private impactMesh: THREE.InstancedMesh;
	private impactStartTimes: Float32Array;
	private maxImpacts = 50;
	private impactIdx = 0;

	private dummy = new THREE.Object3D();

	private readonly _dir = new THREE.Vector3();
	private readonly _seg = new THREE.Vector3();
	private readonly _closest = new THREE.Vector3();
	private readonly _to = new THREE.Vector3();
	private readonly _hitPoint = new THREE.Vector3();
	private readonly _torso = new THREE.Vector3();
	private readonly _up = new THREE.Vector3(0, 1, 0);
	private readonly _quat = new THREE.Quaternion();

	constructor() {
		// Bullet Materials
		this.bulletMat = new MeshStandardNodeMaterial({
			color: 0xffcc44,
			emissive: 0xff8800,
			emissiveIntensity: 2.5,
			metalness: 0.2,
			roughness: 0.35,
			toneMapped: false,
		});

		this.glowMat = new MeshBasicNodeMaterial({
			color: 0xff6600,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		// pulse = 0.45 + Math.sin(performance.now() * 0.04) * 0.15;
		const timeMs = this.uTime.mul(1000.0) as any;
		this.glowMat.opacityNode = add(0.45, mul(sin(mul(timeMs, 0.04)), 0.15));

		// Bullet & Glow InstancedMeshes
		this.bulletMesh = new THREE.InstancedMesh(this.bulletGeo, this.bulletMat, this.maxBullets);
		this.bulletMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.bulletMesh.frustumCulled = false;
		this.bulletMesh.count = 0;
		this.group.add(this.bulletMesh);

		this.glowMesh = new THREE.InstancedMesh(this.glowGeo, this.glowMat, this.maxBullets);
		this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.glowMesh.frustumCulled = false;
		this.glowMesh.count = 0;
		this.glowMesh.visible = false; // user requested to hide the bullet light
		this.group.add(this.glowMesh);

		// Bullet & Glow InstancedMeshes
		this.flashStartTimes = new Float32Array(this.maxFlashes).fill(-10000);
		const flashStartTimeAttr = new THREE.InstancedBufferAttribute(this.flashStartTimes, 1);
		flashStartTimeAttr.setUsage(THREE.DynamicDrawUsage);
		this.flashGeo.setAttribute('aStartTime', flashStartTimeAttr);

		const flashPositions = new Float32Array(this.maxFlashes * 3);
		for(let i = 0; i < this.maxFlashes; i++) flashPositions[i*3 + 1] = -1000;
		const flashPosAttr = new THREE.InstancedBufferAttribute(flashPositions, 3);
		flashPosAttr.setUsage(THREE.DynamicDrawUsage);
		this.flashGeo.setAttribute('aCenterPos', flashPosAttr);

		const flashMat = new MeshBasicNodeMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const aStartTimeFlash = attribute('aStartTime', 'float');
		const rawLifeFlash = this.uTime.sub(aStartTimeFlash as any) as any;
		const flashT = max(0.0, rawLifeFlash.div(0.06).clamp(0.0, 1.0)); // 0 to 1
		const flashScale = float(0.35).add(float(1.0).sub(flashT).mul(0.5));
		
		const aCenterPosFlash = attribute('aCenterPos', 'vec3');
		flashMat.positionNode = aCenterPosFlash.add(positionLocal.mul(flashScale).mul(0.55));
		flashMat.opacityNode = float(1.0).sub(flashT);
		flashMat.colorNode = Fn(() => {
			rawLifeFlash.greaterThan(0.06).or(rawLifeFlash.lessThan(0.0)).discard();
			return color(0xffee88);
		})();

		this.flashMesh = new THREE.InstancedMesh(this.flashGeo, flashMat, this.maxFlashes);
		this.flashMesh.count = this.maxFlashes;
		this.flashMesh.frustumCulled = false;
		
		const identity = new THREE.Matrix4();
		for (let i = 0; i < this.maxFlashes; i++) {
			this.flashMesh.setMatrixAt(i, identity);
		}
		this.group.add(this.flashMesh);

		// Impacts InstancedMesh
		this.impactStartTimes = new Float32Array(this.maxImpacts).fill(-10000);
		const impactStartTimeAttr = new THREE.InstancedBufferAttribute(this.impactStartTimes, 1);
		impactStartTimeAttr.setUsage(THREE.DynamicDrawUsage);
		this.impactGeo.setAttribute('aStartTime', impactStartTimeAttr);

		const impactPositions = new Float32Array(this.maxImpacts * 3);
		for(let i = 0; i < this.maxImpacts; i++) impactPositions[i*3 + 1] = -1000;
		const impactPosAttr = new THREE.InstancedBufferAttribute(impactPositions, 3);
		impactPosAttr.setUsage(THREE.DynamicDrawUsage);
		this.impactGeo.setAttribute('aCenterPos', impactPosAttr);

		const impactMat = new MeshBasicNodeMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const aStartTimeImpact = attribute('aStartTime', 'float');
		const rawLifeImpact = this.uTime.sub(aStartTimeImpact as any) as any;
		const impactU = rawLifeImpact.div(0.18).clamp(0.0, 1.0); // 0 to 1
		const impactScale = float(0.35).add(impactU.mul(1.1));
		
		const aCenterPosImpact = attribute('aCenterPos', 'vec3');
		impactMat.positionNode = aCenterPosImpact.add(positionLocal.mul(impactScale).mul(0.4));
		impactMat.opacityNode = float(1.0).sub(impactU);
		impactMat.colorNode = Fn(() => {
			rawLifeImpact.greaterThan(0.18).or(rawLifeImpact.lessThan(0.0)).discard();
			return color(0xff6622);
		})();

		this.impactMesh = new THREE.InstancedMesh(this.impactGeo, impactMat, this.maxImpacts);
		this.impactMesh.count = this.maxImpacts;
		this.impactMesh.frustumCulled = false;
		
		for (let i = 0; i < this.maxImpacts; i++) {
			this.impactMesh.setMatrixAt(i, identity);
		}
		this.group.add(this.impactMesh);
	}

	spawn(
		origin: THREE.Vector3,
		direction: THREE.Vector3,
		options: { dealDamage?: boolean; ownerId?: string | null } = {}
	) {
		this._dir.copy(direction).normalize();
		if (this._dir.lengthSq() < 1e-6) return;

		const dealDamage = options.dealDamage !== false;
		const ownerId = options.ownerId ?? null;

		this.spawnMuzzleFlash(origin);

		this._quat.setFromUnitVectors(this._up, this._dir);
		const pos = origin.clone().addScaledVector(this._dir, 0.55);

		// Prevent exceeding array size if we shoot continuously
		if (this.bullets.length < this.maxBullets) {
			this.bullets.push({
				pos,
				quat: this._quat.clone(),
				vel: this._dir.clone().multiplyScalar(BulletSystem.SPEED),
				prev: pos.clone(),
				life: BulletSystem.MAX_LIFE,
				hitRadius: 0.08,
				dealDamage,
				ownerId,
			});
		}
	}

	update(
		dt: number,
		targets: BulletTarget[],
		bombs: BombTarget[] = [],
		vehicleTargets: { id: string; position: THREE.Vector3; radius: number }[] = []
	) {
		this.uTime.value += dt;

		for (let i = this.bullets.length - 1; i >= 0; i--) {
			const b = this.bullets[i];
			b.life -= dt;
			b.prev.copy(b.pos);

			b.pos.addScaledVector(b.vel, dt);
			this._dir.copy(b.vel).normalize();
			b.quat.setFromUnitVectors(this._up, this._dir);

			let hitId: string | null = null;
			let hitPart: "head" | "body" = "body";
			let hitBombId: number | null = null;
			let hitDist = Infinity;
			const segLen = Math.max(b.prev.distanceTo(b.pos), 1e-4);

			for (const t of targets) {
				if (b.ownerId && t.id === b.ownerId) continue;

				const dHead = this.segmentSphereHit(b.prev, b.pos, t.head, BulletSystem.HEAD_RADIUS);
				if (dHead !== null && dHead < hitDist) {
					hitDist = dHead;
					hitId = t.id;
					hitPart = "head";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.pos, dHead / segLen);
				}

				const dSpine = this.segmentSphereHit(b.prev, b.pos, t.spine, BulletSystem.BODY_RADIUS);
				if (dSpine !== null && dSpine < hitDist) {
					hitDist = dSpine;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.pos, dSpine / segLen);
				}

				this._torso.set(t.position.x, t.position.y + 1.05, t.position.z);
				const dTorso = this.segmentSphereHit(b.prev, b.pos, this._torso, BulletSystem.TORSO_RADIUS);
				if (dTorso !== null && dTorso < hitDist) {
					hitDist = dTorso;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.pos, dTorso / segLen);
				}
			}

			for (const bomb of bombs) {
				const dBomb = this.segmentSphereHit(b.prev, b.pos, bomb.position, BulletSystem.BOMB_RADIUS);
				if (dBomb !== null && dBomb < hitDist) {
					hitDist = dBomb;
					hitBombId = bomb.id;
					hitId = null;
					this._hitPoint.copy(b.prev).lerp(b.pos, dBomb / segLen);
				}
			}

			for (const v of vehicleTargets) {
				const d = this.segmentSphereHit(b.prev, b.pos, v.position, v.radius);
				if (d !== null && d < hitDist) {
					hitDist = d;
					hitId = v.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.pos, d / segLen);
				}
			}

			if (hitBombId !== null) {
				b.pos.copy(this._hitPoint);
				this.spawnImpact(this._hitPoint);
				if (b.dealDamage) this.onBombHit?.(hitBombId, this._hitPoint);
				this.disposeBullet(i);
				continue;
			}

			if (hitId) {
				b.pos.copy(this._hitPoint);
				this.spawnImpact(this._hitPoint);
				if (b.dealDamage) this.onHit?.(hitId, this._hitPoint, hitPart);
				this.disposeBullet(i);
				continue;
			}

			if (this.getGroundY) {
				const gy = this.getGroundY(b.pos.x, b.pos.z);
				const prevGy = this.getGroundY(b.prev.x, b.prev.z);
				const crossed = b.prev.y > prevGy + 0.08 && b.pos.y <= gy + 0.08;
				if (crossed || b.pos.y <= gy + 0.08) {
					const t = b.prev.y === b.pos.y ? 1 : THREE.MathUtils.clamp((b.prev.y - (prevGy + 0.05)) / (b.prev.y - b.pos.y), 0, 1);
					this._hitPoint.copy(b.prev).lerp(b.pos, t);
					this._hitPoint.y = gy + 0.05;
					b.pos.copy(this._hitPoint);
					this.spawnImpact(this._hitPoint);
					this.disposeBullet(i);
					continue;
				}
			}

			if (b.life <= 0) {
				this.disposeBullet(i);
			}
		}

		// Sync alive bullets to InstancedMesh
		this.bulletMesh.count = this.bullets.length;
		this.glowMesh.count = this.bullets.length;
		for (let i = 0; i < this.bullets.length; i++) {
			const b = this.bullets[i];
			this.dummy.position.copy(b.pos);
			this.dummy.quaternion.copy(b.quat);
			this.dummy.scale.setScalar(1);
			this.dummy.updateMatrix();
			this.bulletMesh.setMatrixAt(i, this.dummy.matrix);
			this.glowMesh.setMatrixAt(i, this.dummy.matrix);
		}
		this.bulletMesh.instanceMatrix.needsUpdate = true;
		this.glowMesh.instanceMatrix.needsUpdate = true;
	}

	dispose() {
		this.bullets.length = 0;
		
		this.bulletGeo.dispose();
		this.glowGeo.dispose();
		this.flashGeo.dispose();
		this.impactGeo.dispose();
		this.bulletMat.dispose();
		this.glowMat.dispose();
		
		(this.flashMesh.material as THREE.Material).dispose();
		(this.impactMesh.material as THREE.Material).dispose();
		(this.bulletMesh.material as THREE.Material).dispose();
		(this.glowMesh.material as THREE.Material).dispose();
	}

	private segmentSphereHit(
		a: THREE.Vector3,
		b: THREE.Vector3,
		center: THREE.Vector3,
		radius: number
	): number | null {
		this._seg.copy(b).sub(a);
		const len = this._seg.length();
		if (len < 1e-8) {
			return a.distanceTo(center) <= radius ? 0 : null;
		}
		this._seg.multiplyScalar(1 / len);
		this._to.copy(center).sub(a);
		const t = THREE.MathUtils.clamp(this._to.dot(this._seg), 0, len);
		this._closest.copy(a).addScaledVector(this._seg, t);
		if (this._closest.distanceToSquared(center) <= radius * radius) {
			return t;
		}
		return null;
	}

	private spawnMuzzleFlash(origin: THREE.Vector3) {
		const idx = this.flashIdx;
		this.flashIdx = (this.flashIdx + 1) % this.maxFlashes;

		const posAttr = this.flashMesh.geometry.getAttribute('aCenterPos') as THREE.InstancedBufferAttribute;
		posAttr.setXYZ(idx, origin.x, origin.y, origin.z);
		posAttr.needsUpdate = true;

		this.flashStartTimes[idx] = this.uTime.value;
		const attr = this.flashMesh.geometry.getAttribute('aStartTime') as THREE.InstancedBufferAttribute;
		attr.needsUpdate = true;
	}

	private spawnImpact(point: THREE.Vector3) {
		const idx = this.impactIdx;
		this.impactIdx = (this.impactIdx + 1) % this.maxImpacts;

		const posAttr = this.impactMesh.geometry.getAttribute('aCenterPos') as THREE.InstancedBufferAttribute;
		posAttr.setXYZ(idx, point.x, point.y, point.z);
		posAttr.needsUpdate = true;

		this.impactStartTimes[idx] = this.uTime.value;
		const attr = this.impactMesh.geometry.getAttribute('aStartTime') as THREE.InstancedBufferAttribute;
		attr.needsUpdate = true;
	}

	private disposeBullet(index: number) {
		this.bullets.splice(index, 1);
	}
}
