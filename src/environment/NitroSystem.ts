import * as THREE from "three";

interface Particle {
	position: THREE.Vector3;
	life: number;
	maxLife: number;
	peakScale: number;
	drift: THREE.Vector3;
	rotationAxis: THREE.Vector3;
	rotationSpeed: number;
	rotationAngle: number;
}

export class NitroSystem {
	public mesh: THREE.InstancedMesh;
	private count: number;
	private activeParticles: Particle[] = [];
	private maxLife = 0.3;
	private readonly dummy = new THREE.Object3D();
	
	// Start with blue/cyan, transition to orange/fire
	private readonly colorStart = new THREE.Color(0x00aaff); // Cyan/Blue
	private readonly colorEnd = new THREE.Color(0xff6600); // Orange
	private readonly particleColor = new THREE.Color();

	constructor(maxParticles = 600) {
		this.count = maxParticles;
		const geometry = new THREE.IcosahedronGeometry(0.28, 0);

		const material = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.6,
			depthWrite: false,
			blending: THREE.AdditiveBlending, // Nitro looks best with additive
		});

		this.mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
		this.mesh.count = 0;
		this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 11;
	}

	emit(position: THREE.Vector3, direction: THREE.Vector3) {
		if (this.activeParticles.length >= this.count) {
			this.activeParticles.shift();
		}

		const life = 0.15 + Math.random() * 0.15;
		
		// Shoot opposite to the direction of travel (car forward), with some spread
		const drift = new THREE.Vector3(
			-direction.x * 12 + (Math.random() - 0.5) * 2,
			-direction.y * 12 + (Math.random() - 0.5) * 2,
			-direction.z * 12 + (Math.random() - 0.5) * 2
		);

		this.activeParticles.push({
			position: position.clone(),
			life,
			maxLife: life,
			peakScale: 0.6 + Math.random() * 0.4,
			drift,
			rotationAxis: new THREE.Vector3(
				Math.random(),
				Math.random(),
				Math.random()
			).normalize(),
			rotationSpeed: (Math.random() - 0.5) * 15.0,
			rotationAngle: Math.random() * Math.PI * 2,
		});
	}

	update(dt: number) {
		let writeIdx = 0;
		for (let i = 0; i < this.activeParticles.length; i++) {
			const p = this.activeParticles[i];
			p.life -= dt;

			if (p.life <= 0) continue;

			p.position.addScaledVector(p.drift, dt);
			// Slow down the particles a bit over time
			p.drift.multiplyScalar(1 - 4.0 * dt);

			p.rotationAngle += p.rotationSpeed * dt;
			this.dummy.quaternion.setFromAxisAngle(p.rotationAxis, p.rotationAngle);

			const lifeRatio = p.life / p.maxLife; // 1 -> 0 (start to end)
			const age = 1 - lifeRatio; // 0 -> 1

			// Peak scale at start, shrink to 0
			const scale = p.peakScale * lifeRatio;

			if (scale < 0.05) continue;

			// Color transition: blue -> orange
			this.particleColor.copy(this.colorStart).lerp(this.colorEnd, age * 1.5);

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
