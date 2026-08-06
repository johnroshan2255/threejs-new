import * as THREE from 'three';

export class ExplosionSystem {
	public mesh: THREE.Group;
	private explosions: { mesh: THREE.Mesh, material: THREE.MeshBasicMaterial, life: number, maxLife: number }[] = [];
	private textureLoader = new THREE.TextureLoader();
	private noiseTexture: THREE.Texture;

	constructor() {
		this.mesh = new THREE.Group();
		
		// Load noise texture for the dissolve effect
		this.noiseTexture = this.textureLoader.load('/perlinnoise.webp');
		this.noiseTexture.wrapS = THREE.RepeatWrapping;
		this.noiseTexture.wrapT = THREE.RepeatWrapping;
	}

	emit(position: THREE.Vector3) {
		const geometry = new THREE.SphereGeometry(1.0, 32, 32);
		
		const material = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

		const expMesh = new THREE.Mesh(geometry, material);
		expMesh.position.copy(position);
		// Random rotation so they don't all look identical
		expMesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
		
		this.mesh.add(expMesh);
		
		this.explosions.push({
			mesh: expMesh,
			material: material,
			life: 0.0,
			maxLife: 1.0 // 1 second duration
		});
	}

	update(dt: number) {
		for (let i = this.explosions.length - 1; i >= 0; i--) {
			const exp = this.explosions[i];
			exp.life += dt;
			
			if (exp.life >= exp.maxLife) {
				// Remove dead explosion
				this.mesh.remove(exp.mesh);
				exp.mesh.geometry.dispose();
				exp.material.dispose();
				this.explosions.splice(i, 1);
			} else {
				const lifeRatio = exp.life / exp.maxLife;
				(exp.material as any).uniforms.uLife.value = lifeRatio;
			}
		}
	}
}
