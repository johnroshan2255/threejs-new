import * as THREE from 'three';

interface Particle {
	position: THREE.Vector3;
	life: number;
	maxLife: number;
	scale: number;
	drift: THREE.Vector3;
	rotationAxis: THREE.Vector3;
	rotationSpeed: number;
	rotationAngle: number;
}

export class SmokeTrailSystem {
	public mesh: THREE.InstancedMesh;
	private count: number;
	private activeParticles: Particle[] = [];
	private maxLife = 0.5; // Half second trail
	private readonly dummy = new THREE.Object3D();
	private readonly colorWhite = new THREE.Color(0xffffff);
	private readonly colorGrey = new THREE.Color(0x999999);
	private readonly particleColor = new THREE.Color();

	constructor(maxParticles = 500) {
		this.count = maxParticles;
		
		// Use a low-poly geometry (Icosahedron with 0 detail) to match Kenney style
		const geometry = new THREE.IcosahedronGeometry(0.3, 0);
		
		const material = new THREE.MeshLambertMaterial({
			color: 0xffffff, // White cartoon smoke
			transparent: true,
			opacity: 0.8,
			flatShading: true, // Matches low-poly look
			depthWrite: false, 
		});
		
		this.mesh = new THREE.InstancedMesh(geometry, material, maxParticles);
		this.mesh.count = 0;
		this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
		this.mesh.frustumCulled = false; // MUST be false since instances are moved far from origin
	}

	emit(position: THREE.Vector3) {
		if (this.activeParticles.length >= this.count) {
			this.activeParticles.shift();
		}
		
		this.activeParticles.push({
			position: position.clone(),
			life: this.maxLife,
			maxLife: this.maxLife,
			scale: 1.0, 
			drift: new THREE.Vector3(
				(Math.random() - 0.5) * 1.5,
				Math.random() * 2.0 + 1.0, // Drift upwards faster
				(Math.random() - 0.5) * 1.5
			),
			rotationAxis: new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(),
			rotationSpeed: (Math.random() - 0.5) * 10.0,
			rotationAngle: Math.random() * Math.PI * 2
		});
	}

	update(dt: number) {
		let writeIdx = 0;
		for (let i = 0; i < this.activeParticles.length; i++) {
			const p = this.activeParticles[i];
			p.life -= dt;
			
			if (p.life > 0) {
				// Move particle
				p.position.addScaledVector(p.drift, dt);
				
				// Rotate particle
				p.rotationAngle += p.rotationSpeed * dt;
				this.dummy.quaternion.setFromAxisAngle(p.rotationAxis, p.rotationAngle);
				
				// Scale shrinks over time
				const lifeRatio = p.life / p.maxLife; // 1 to 0
				
				// Pop in slightly, then shrink to nothing
				if (lifeRatio > 0.8) {
					p.scale = THREE.MathUtils.lerp(0.5, 1.2, (1.0 - lifeRatio) / 0.2);
				} else {
					p.scale = THREE.MathUtils.lerp(0.0, 1.2, lifeRatio / 0.8);
				}
				
				this.dummy.position.copy(p.position);
				this.dummy.scale.setScalar(p.scale);
				this.dummy.updateMatrix();
				
				// Color darkens to grey as it fades
				this.particleColor.lerpColors(
					this.colorGrey,
					this.colorWhite,
					lifeRatio
				);
				
				this.mesh.setMatrixAt(writeIdx, this.dummy.matrix);
				this.mesh.setColorAt(writeIdx, this.particleColor);
				writeIdx++;
			}
		}
		
		// Clean up dead particles
		if (this.activeParticles.length > writeIdx) {
			this.activeParticles = this.activeParticles.filter(p => p.life > 0);
		}
		
		this.mesh.count = writeIdx;
		this.mesh.instanceMatrix.needsUpdate = true;
		if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
	}
}
