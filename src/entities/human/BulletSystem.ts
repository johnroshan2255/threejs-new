import * as THREE from "three";

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

type Flash = {
	light: THREE.PointLight;
	sprite: THREE.Mesh;
	life: number;
	maxLife: number;
};

type Impact = {
	mesh: THREE.Mesh;
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
	public onBombHit: ((bombId: number, point: THREE.Vector3) => void) | null =
		null;
	public getGroundY: ((x: number, z: number) => number) | null = null;

	private bullets: Bullet[] = [];
	private flashes: Flash[] = [];
	private impacts: Impact[] = [];

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

	private readonly _dir = new THREE.Vector3();
	private readonly _seg = new THREE.Vector3();
	private readonly _closest = new THREE.Vector3();
	private readonly _to = new THREE.Vector3();
	private readonly _hitPoint = new THREE.Vector3();
	private readonly _torso = new THREE.Vector3();
	private readonly _up = new THREE.Vector3(0, 1, 0);
	private readonly _quat = new THREE.Quaternion();

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

		const mat = new THREE.MeshStandardMaterial({
			color: 0xffcc44,
			emissive: 0xff8800,
			emissiveIntensity: 2.5,
			metalness: 0.2,
			roughness: 0.35,
			toneMapped: false,
		});
		const mesh = new THREE.Mesh(this.bulletGeo, mat);
		mesh.castShadow = false;

		const glowMat = new THREE.MeshBasicMaterial({
			color: 0xff6600,
			transparent: true,
			opacity: 0.55,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const glow = new THREE.Mesh(this.glowGeo, glowMat);
		mesh.add(glow);

		// Orient capsule along flight direction (capsule default is Y-up)
		this._quat.setFromUnitVectors(this._up, this._dir);
		mesh.quaternion.copy(this._quat);
		// Start just ahead of the muzzle so remote tracers don't die in the shooter
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

	private _raycaster = new THREE.Raycaster();

	update(
		dt: number,
		targets: BulletTarget[],
		bombs: BombTarget[] = [],
		vehicleTargets: { id: string; position: THREE.Vector3; radius: number }[] = []
	) {
		this.updateFlashes(dt);
		this.updateImpacts(dt);

		for (let i = this.bullets.length - 1; i >= 0; i--) {
			const b = this.bullets[i];
			b.life -= dt;
			b.prev.copy(b.mesh.position);

			b.mesh.position.addScaledVector(b.vel, dt);
			this._dir.copy(b.vel).normalize();
			b.mesh.quaternion.setFromUnitVectors(this._up, this._dir);

			const pulse = 0.45 + Math.sin(performance.now() * 0.04) * 0.15;
			(b.glow.material as THREE.MeshBasicMaterial).opacity = pulse;

			let hitId: string | null = null;
			let hitPart: "head" | "body" = "body";
			let hitBombId: number | null = null;
			let hitDist = Infinity;
			const segLen = Math.max(b.prev.distanceTo(b.mesh.position), 1e-4);

			for (const t of targets) {
				if (b.ownerId && t.id === b.ownerId) continue;

				const dHead = this.segmentSphereHit(
					b.prev,
					b.mesh.position,
					t.head,
					BulletSystem.HEAD_RADIUS
				);
				if (dHead !== null && dHead < hitDist) {
					hitDist = dHead;
					hitId = t.id;
					hitPart = "head";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dHead / segLen);
				}

				const dSpine = this.segmentSphereHit(
					b.prev,
					b.mesh.position,
					t.spine,
					BulletSystem.BODY_RADIUS
				);
				if (dSpine !== null && dSpine < hitDist) {
					hitDist = dSpine;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dSpine / segLen);
				}

				// Extra torso volume so shots don't visually pass through the body
				this._torso.set(t.position.x, t.position.y + 1.05, t.position.z);
				const dTorso = this.segmentSphereHit(
					b.prev,
					b.mesh.position,
					this._torso,
					BulletSystem.TORSO_RADIUS
				);
				if (dTorso !== null && dTorso < hitDist) {
					hitDist = dTorso;
					hitId = t.id;
					hitPart = "body";
					hitBombId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dTorso / segLen);
				}
			}

			for (const bomb of bombs) {
				const dBomb = this.segmentSphereHit(
					b.prev,
					b.mesh.position,
					bomb.position,
					BulletSystem.BOMB_RADIUS
				);
				if (dBomb !== null && dBomb < hitDist) {
					hitDist = dBomb;
					hitBombId = bomb.id;
					hitId = null;
					this._hitPoint.copy(b.prev).lerp(b.mesh.position, dBomb / segLen);
				}
			}

			for (const v of vehicleTargets) {
				const d = this.segmentSphereHit(
					b.prev,
					b.mesh.position,
					v.position,
					v.radius
				);
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

			// Ground stop (also if we crossed the surface this frame)
			if (this.getGroundY) {
				const gy = this.getGroundY(b.mesh.position.x, b.mesh.position.z);
				const prevGy = this.getGroundY(b.prev.x, b.prev.z);
				const crossed =
					b.prev.y > prevGy + 0.08 && b.mesh.position.y <= gy + 0.08;
				if (crossed || b.mesh.position.y <= gy + 0.08) {
					const t =
						b.prev.y === b.mesh.position.y
							? 1
							: THREE.MathUtils.clamp(
									(b.prev.y - (prevGy + 0.05)) /
										(b.prev.y - b.mesh.position.y),
									0,
									1
								);
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
		while (this.flashes.length) this.disposeFlash(0);
		while (this.impacts.length) this.disposeImpact(0);
		this.bulletGeo.dispose();
		this.glowGeo.dispose();
		this.flashGeo.dispose();
		this.impactGeo.dispose();
	}

	/** Distance along segment to first sphere hit, or null. */
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

		const mat = new THREE.MeshBasicMaterial({
			color: 0xffee88,
			transparent: true,
			opacity: 0.95,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const sprite = new THREE.Mesh(this.flashGeo, mat);
		sprite.position.copy(origin);
		sprite.scale.setScalar(0.55);
		this.group.add(sprite);

		this.flashes.push({ light, sprite, life: 0.06, maxLife: 0.06 });
	}

	private spawnImpact(point: THREE.Vector3) {
		const mat = new THREE.MeshBasicMaterial({
			color: 0xff6622,
			transparent: true,
			opacity: 1,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
		});
		const mesh = new THREE.Mesh(this.impactGeo, mat);
		mesh.position.copy(point);
		mesh.scale.setScalar(0.4);
		this.group.add(mesh);
		this.impacts.push({ mesh, life: 0.18, maxLife: 0.18 });
	}

	private updateFlashes(dt: number) {
		for (let i = this.flashes.length - 1; i >= 0; i--) {
			const f = this.flashes[i];
			f.life -= dt;
			const t = Math.max(0, f.life / f.maxLife);
			f.light.intensity = 4.5 * t;
			f.sprite.scale.setScalar(0.35 + (1 - t) * 0.5);
			(f.sprite.material as THREE.MeshBasicMaterial).opacity = t;
			if (f.life <= 0) this.disposeFlash(i);
		}
	}

	private updateImpacts(dt: number) {
		for (let i = this.impacts.length - 1; i >= 0; i--) {
			const p = this.impacts[i];
			p.life -= dt;
			const u = 1 - Math.max(0, p.life / p.maxLife);
			p.mesh.scale.setScalar(0.35 + u * 1.1);
			(p.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - u;
			if (p.life <= 0) this.disposeImpact(i);
		}
	}

	private disposeBullet(index: number) {
		const b = this.bullets[index];
		this.group.remove(b.mesh);
		(b.mesh.material as THREE.Material).dispose();
		(b.glow.material as THREE.Material).dispose();
		this.bullets.splice(index, 1);
	}

	private disposeFlash(index: number) {
		const f = this.flashes[index];
		this.group.remove(f.light);
		this.group.remove(f.sprite);
		(f.sprite.material as THREE.Material).dispose();
		this.flashes.splice(index, 1);
	}

	private disposeImpact(index: number) {
		const p = this.impacts[index];
		this.group.remove(p.mesh);
		(p.mesh.material as THREE.Material).dispose();
		this.impacts.splice(index, 1);
	}
}
