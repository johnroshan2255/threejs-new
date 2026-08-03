import * as THREE from "three";

interface Particle {
	position: THREE.Vector3;
	life: number;
	maxLife: number;
	/** Peak visual size. */
	peakScale: number;
	drift: THREE.Vector3;
	rotationAxis: THREE.Vector3;
	rotationSpeed: number;
	rotationAngle: number;
	/** 0 = bomb puff, 1 = tire fog, 2 = dark smoke, 3 = fire. */
	kind: 0 | 1 | 2 | 3;
}

export class SmokeTrailSystem {
	public mesh: THREE.InstancedMesh;
	private count: number;
	private activeParticles: Particle[] = [];
	private maxLife = 0.55;
	private readonly dummy = new THREE.Object3D();
	private readonly colorWhite = new THREE.Color(0xffffff);
	private readonly colorGrey = new THREE.Color(0xaaaaaa);
	private readonly colorFog = new THREE.Color(0xc8c8c8);
	private readonly colorDark = new THREE.Color(0x222222);
	private readonly colorFireCore = new THREE.Color(0xffaa00);
	private readonly colorFireEdge = new THREE.Color(0xff2200);
	private readonly particleColor = new THREE.Color();

	constructor(maxParticles = 500) {
		this.count = maxParticles;

		const geometry = new THREE.IcosahedronGeometry(0.28, 0);

		const material = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.45,
			depthWrite: false,
			blending: THREE.NormalBlending,
		});

		this.mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
		this.mesh.count = 0;
		this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 10;
	}

	emit(position: THREE.Vector3) {
		this._emitGeneric(position, 0, 1.15, this.maxLife);
	}

	emitDarkSmoke(position: THREE.Vector3) {
		this._emitGeneric(position, 2, 1.5, this.maxLife + Math.random() * 0.4);
	}

	emitFire(position: THREE.Vector3) {
		this._emitGeneric(position, 3, 0.8 + Math.random() * 0.4, 0.3 + Math.random() * 0.2);
	}

	private _emitGeneric(position: THREE.Vector3, kind: 0 | 1 | 2 | 3, peakScale: number, life: number) {
		if (this.activeParticles.length >= this.count) {
			this.activeParticles.shift();
		}

		this.activeParticles.push({
			position: position.clone(),
			life,
			maxLife: life,
			peakScale,
			drift: new THREE.Vector3(
				(Math.random() - 0.5) * 1.5,
				Math.random() * 2.0 + 1.0,
				(Math.random() - 0.5) * 1.5
			),
			rotationAxis: new THREE.Vector3(
				Math.random(),
				Math.random(),
				Math.random()
			).normalize(),
			rotationSpeed: (Math.random() - 0.5) * 10.0,
			rotationAngle: Math.random() * Math.PI * 2,
			kind,
		});
	}

	/**
	 * Tire fog: appears under the wheel, drifts out, shrinks away to nothing
	 */
	emitTire(position: THREE.Vector3) {
		if (this.activeParticles.length >= this.count) {
			this.activeParticles.shift();
		}

		const life = 0.55 + Math.random() * 0.25;
		this.activeParticles.push({
			position: position.clone(),
			life,
			maxLife: life,
			peakScale: 0.55 + Math.random() * 0.35,
			drift: new THREE.Vector3(
				(Math.random() - 0.5) * 1.6,
				0.35 + Math.random() * 0.7,
				(Math.random() - 0.5) * 1.6
			),
			rotationAxis: new THREE.Vector3(
				Math.random(),
				Math.random(),
				Math.random()
			).normalize(),
			rotationSpeed: (Math.random() - 0.5) * 6.0,
			rotationAngle: Math.random() * Math.PI * 2,
			kind: 1,
		});
	}

	update(dt: number) {
		let writeIdx = 0;
		for (let i = 0; i < this.activeParticles.length; i++) {
			const p = this.activeParticles[i];
			p.life -= dt;

			if (p.life <= 0) continue;

			p.position.addScaledVector(p.drift, dt);
			// Fog slows as it dies, fire/smoke rises
			if (p.kind === 1) {
				p.drift.multiplyScalar(1 - 0.8 * dt);
			} else {
				p.drift.multiplyScalar(1 - 0.2 * dt);
			}

			p.rotationAngle += p.rotationSpeed * dt;
			this.dummy.quaternion.setFromAxisAngle(p.rotationAxis, p.rotationAngle);

			const lifeRatio = p.life / p.maxLife; // 1 → 0
			const age = 1 - lifeRatio; // 0 → 1

			let scale: number;
			if (p.kind === 1) {
				// Tire fog
				const appear = Math.min(1, age / 0.18);
				const fade = lifeRatio < 0.45 ? lifeRatio / 0.45 : 1;
				scale = p.peakScale * appear * fade;
				scale *= 1 + age * 0.65;
				this.particleColor.copy(this.colorFog).lerp(this.colorGrey, age);
			} else if (p.kind === 2) {
				// Dark smoke
				if (lifeRatio > 0.8) {
					scale = THREE.MathUtils.lerp(0.5, p.peakScale, (1.0 - lifeRatio) / 0.2);
				} else {
					scale = THREE.MathUtils.lerp(0.0, p.peakScale, lifeRatio / 0.8);
				}
				this.particleColor.lerpColors(this.colorDark, this.colorGrey, lifeRatio);
			} else if (p.kind === 3) {
				// Fire
				scale = p.peakScale * lifeRatio; // Shrinks as it burns
				this.particleColor.lerpColors(this.colorDark, this.colorFireCore, lifeRatio);
			} else {
				// Normal smoke
				if (lifeRatio > 0.8) {
					scale = THREE.MathUtils.lerp(0.5, p.peakScale, (1.0 - lifeRatio) / 0.2);
				} else {
					scale = THREE.MathUtils.lerp(0.0, p.peakScale, lifeRatio / 0.8);
				}
				this.particleColor.lerpColors(this.colorGrey, this.colorWhite, lifeRatio);
			}

			if (scale < 0.02) continue;

			this.dummy.position.copy(p.position);
			this.dummy.scale.setScalar(scale);
			this.dummy.updateMatrix();

			this.mesh.setMatrixAt(writeIdx, this.dummy.matrix);
			this.mesh.setColorAt(writeIdx, this.particleColor);
			writeIdx++;
		}

		if (this.activeParticles.length !== writeIdx) {
			this.activeParticles = this.activeParticles.filter((p) => p.life > 0);
		}

		this.mesh.count = writeIdx;
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
	}
}
