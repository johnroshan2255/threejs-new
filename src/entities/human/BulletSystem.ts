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
	mesh: THREE.Mesh;
	glow: THREE.Mesh;
	vel: THREE.Vector3;
	prev: THREE.Vector3;
	life: number;
	hitRadius: number;
	/** False for remote visual tracers — no damage / bomb detonation. */
	dealDamage: boolean;
	/** Skip collision with this player (the shooter). */
	ownerId: string | null;
};

type FlashLight = {
	light: THREE.PointLight;
	life: number;
	maxLife: number;
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
	private flashLights: FlashLight[] = [];
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

		// Flashes InstancedMesh
		this.flashStartTimes = new Float32Array(this.maxFlashes).fill(-10000);
		const flashStartTimeAttr = new THREE.InstancedBufferAttribute(this.flashStartTimes, 1);
		flashStartTimeAttr.setUsage(THREE.DynamicDrawUsage);
		this.flashGeo.setAttribute('aStartTime', flashStartTimeAttr);
		const flashMat = new MeshBasicNodeMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const aStartTimeFlash = attribute('aStartTime', 'float');
		const rawLifeFlash = this.uTime.sub(aStartTimeFlash as any) as any;
		const flashT = max(0.0, rawLifeFlash.div(0.06).clamp(0.0, 1.0)); // 0 to 1
		const flashScale = float(0.35).add(float(1.0).sub(flashT).mul(0.5));
		flashMat.positionNode = positionLocal.mul(flashScale).mul(0.55);
		flashMat.opacityNode = float(1.0).sub(flashT);
		flashMat.colorNode = Fn(() => {
			rawLifeFlash.greaterThan(0.06).or(rawLifeFlash.lessThan(0.0)).discard();
			return color(0xffee88);
		})();

		this.flashMesh = new THREE.InstancedMesh(this.flashGeo, flashMat, this.maxFlashes);
		this.flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.flashMesh.count = this.maxFlashes;
		this.flashMesh.frustumCulled = false;
		for (let i = 0; i < this.maxFlashes; i++) {
			this.flashMesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
		}
		this.group.add(this.flashMesh);

		// Impacts InstancedMesh
		this.impactStartTimes = new Float32Array(this.maxImpacts).fill(-10000);
		const impactStartTimeAttr = new THREE.InstancedBufferAttribute(this.impactStartTimes, 1);
		impactStartTimeAttr.setUsage(THREE.DynamicDrawUsage);
		this.impactGeo.setAttribute('aStartTime', impactStartTimeAttr);
		const impactMat = new MeshBasicNodeMaterial({
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const aStartTimeImpact = attribute('aStartTime', 'float');
		const rawLifeImpact = this.uTime.sub(aStartTimeImpact as any) as any;
		const impactU = rawLifeImpact.div(0.18).clamp(0.0, 1.0); // 0 to 1
		const impactScale = float(0.35).add(impactU.mul(1.1));
		impactMat.positionNode = positionLocal.mul(impactScale).mul(0.4);
		impactMat.opacityNode = float(1.0).sub(impactU);
		impactMat.colorNode = Fn(() => {
			rawLifeImpact.greaterThan(0.18).or(rawLifeImpact.lessThan(0.0)).discard();
			return color(0xff6622);
		})();

		this.impactMesh = new THREE.InstancedMesh(this.impactGeo, impactMat, this.maxImpacts);
		this.impactMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.impactMesh.count = this.maxImpacts;
		this.impactMesh.frustumCulled = false;
		for (let i = 0; i < this.maxImpacts; i++) {
			this.impactMesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
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

		const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
		mesh.castShadow = false;

		const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
		mesh.add(glow);

		this._quat.setFromUnitVectors(this._up, this._dir);
		mesh.quaternion.copy(this._quat);
		mesh.position.copy(origin).addScaledVector(this._dir, 0.55);

		this.group.add(mesh);

		this.bullets.push({
			mesh,
			glow,
			vel: this._dir.clone().multiplyScalar(BulletSystem.SPEED),
			prev: mesh.position.clone(),
			life: BulletSystem.MAX_LIFE,
			hitRadius: 0.08,
			dealDamage,
			ownerId,
		});
	}

	update(
		dt: number,
		targets: BulletTarget[],
		bombs: BombTarget[] = [],
		vehicleTargets: { id: string; position: THREE.Vector3; radius: number }[] = []
	) {
		this.uTime.value += dt;
		this.updateFlashes(dt);

		for (let i = this.bullets.length - 1; i >= 0; i--) {
			const b = this.bullets[i];
			b.life -= dt;
			b.prev.copy(b.mesh.position);

			b.mesh.position.addScaledVector(b.vel, dt);
			this._dir.copy(b.vel).normalize();
			b.mesh.quaternion.setFromUnitVectors(this._up, this._dir);

			let hitId: string | null = null;
			let hitPart: "head" | "body" = "body";
			let hitBombId: number | null = null;
			let hitDist = Infinity;
			const segLen = Math.max(b.prev.distanceTo(b.mesh.position), 1e-4);

			for (const t of targets) {
				if (b.ownerId && t.id === b.ownerId) continue;

				const dHead = this.segmentSphereHit(b.prev, b.mesh.position, t.head, BulletSystem.HEAD_RADIUS);
				if (dHead !== null && dHead < hitDist) {
					hitDist = dHead;
					hitId = t.id;
					hitPart = "head";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dHead / segLen);
				}

				const dSpine = this.segmentSphereHit(b.prev, b.mesh.position, t.spine, BulletSystem.BODY_RADIUS);
				if (dSpine !== null && dSpine < hitDist) {
					hitDist = dSpine;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dSpine / segLen);
				}

				this._torso.set(t.position.x, t.position.y + 1.05, t.position.z);
				const dTorso = this.segmentSphereHit(b.prev, b.mesh.position, this._torso, BulletSystem.TORSO_RADIUS);
				if (dTorso !== null && dTorso < hitDist) {
					hitDist = dTorso;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dTorso / segLen);
				}
			}

			for (const bomb of bombs) {
				const dBomb = this.segmentSphereHit(b.prev, b.mesh.position, bomb.position, BulletSystem.BOMB_RADIUS);
				if (dBomb !== null && dBomb < hitDist) {
					hitDist = dBomb;
					hitBombId = bomb.id;
					hitId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dBomb / segLen);
				}
			}

			for (const v of vehicleTargets) {
				const d = this.segmentSphereHit(b.prev, b.mesh.position, v.position, v.radius);
				if (d !== null && d < hitDist) {
					hitDist = d;
					hitId = v.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, d / segLen);
				}
			}

			if (hitBombId !== null) {
				b.mesh.position.copy(this._hitPoint);
				this.spawnImpact(this._hitPoint);
				if (b.dealDamage) this.onBombHit?.(hitBombId, this._hitPoint);
				this.disposeBullet(i);
				continue;
			}

			if (hitId) {
				b.mesh.position.copy(this._hitPoint);
				this.spawnImpact(this._hitPoint);
				if (b.dealDamage) this.onHit?.(hitId, this._hitPoint, hitPart);
				this.disposeBullet(i);
				continue;
			}

			if (this.getGroundY) {
				const gy = this.getGroundY(b.mesh.position.x, b.mesh.position.z);
				const prevGy = this.getGroundY(b.prev.x, b.prev.z);
				const crossed = b.prev.y > prevGy + 0.08 && b.mesh.position.y <= gy + 0.08;
				if (crossed || b.mesh.position.y <= gy + 0.08) {
					const t = b.prev.y === b.mesh.position.y ? 1 : THREE.MathUtils.clamp((b.prev.y - (prevGy + 0.05)) / (b.prev.y - b.mesh.position.y), 0, 1);
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, t);
					this._hitPoint.y = gy + 0.05;
					b.mesh.position.copy(this._hitPoint);
					this.spawnImpact(this._hitPoint);
					this.disposeBullet(i);
					continue;
				}
			}

			if (b.life <= 0) {
				this.disposeBullet(i);
			}
		}
	}

	dispose() {
		while (this.bullets.length) this.disposeBullet(0);
		while (this.flashLights.length) this.disposeFlashLight(0);
		
		this.bulletGeo.dispose();
		this.glowGeo.dispose();
		this.flashGeo.dispose();
		this.impactGeo.dispose();
		this.bulletMat.dispose();
		this.glowMat.dispose();
		
		(this.flashMesh.material as THREE.Material).dispose();
		(this.impactMesh.material as THREE.Material).dispose();
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
		const light = new THREE.PointLight(0xffaa33, 4.5, 6, 2);
		light.position.copy(origin);
		this.group.add(light);
		this.flashLights.push({ light, life: 0.06, maxLife: 0.06 });

		const idx = this.flashIdx;
		this.flashIdx = (this.flashIdx + 1) % this.maxFlashes;

		this.dummy.position.copy(origin);
		this.dummy.rotation.set(0, 0, 0); // Sprite conceptually, rotation doesn't matter much for a sphere
		this.dummy.scale.setScalar(1);
		this.dummy.updateMatrix();

		this.flashMesh.setMatrixAt(idx, this.dummy.matrix);
		this.flashMesh.instanceMatrix.needsUpdate = true;

		this.flashStartTimes[idx] = this.uTime.value;
		const attr = this.flashMesh.geometry.getAttribute('aStartTime') as THREE.InstancedBufferAttribute;
		attr.needsUpdate = true;
	}

	private spawnImpact(point: THREE.Vector3) {
		const idx = this.impactIdx;
		this.impactIdx = (this.impactIdx + 1) % this.maxImpacts;

		this.dummy.position.copy(point);
		this.dummy.rotation.set(0, 0, 0);
		this.dummy.scale.setScalar(1);
		this.dummy.updateMatrix();

		this.impactMesh.setMatrixAt(idx, this.dummy.matrix);
		this.impactMesh.instanceMatrix.needsUpdate = true;

		this.impactStartTimes[idx] = this.uTime.value;
		const attr = this.impactMesh.geometry.getAttribute('aStartTime') as THREE.InstancedBufferAttribute;
		attr.needsUpdate = true;
	}

	private updateFlashes(dt: number) {
		for (let i = this.flashLights.length - 1; i >= 0; i--) {
			const f = this.flashLights[i];
			f.life -= dt;
			const t = Math.max(0, f.life / f.maxLife);
			f.light.intensity = 4.5 * t;
			if (f.life <= 0) this.disposeFlashLight(i);
		}
	}

	private disposeBullet(index: number) {
		const b = this.bullets[index];
		this.group.remove(b.mesh);
		this.bullets.splice(index, 1);
	}

	private disposeFlashLight(index: number) {
		const f = this.flashLights[index];
		this.group.remove(f.light);
		this.flashLights.splice(index, 1);
	}
}
