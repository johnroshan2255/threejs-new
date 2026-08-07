import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
	Fn,
	If,
	float,
	mix,
	normalLocal,
	positionLocal,
	pow,
	texture,
	uniform,
	uv,
	vec2,
	vec3,
} from 'three/tsl';

type ExplosionMaterial = MeshBasicNodeMaterial & { uLife: { value: number } };

export class ExplosionSystem {
	public mesh: THREE.Group;
	private explosions: { mesh: THREE.Mesh, material: ExplosionMaterial, life: number, maxLife: number }[] = [];
	private textureLoader = new THREE.TextureLoader();
	private noiseTexture: THREE.Texture;

	constructor() {
		this.mesh = new THREE.Group();

		// Load noise texture for the dissolve effect
		this.noiseTexture = this.textureLoader.load('/perlinnoise.webp');
		this.noiseTexture.wrapS = THREE.RepeatWrapping;
		this.noiseTexture.wrapT = THREE.RepeatWrapping;
	}

	/**
	 * One material per explosion, because `uLife` is per-instance and drives both
	 * the vertex displacement and the dissolve threshold.
	 */
	private createMaterial(): ExplosionMaterial {
		const uLife = uniform(0);
		const tNoise = texture(this.noiseTexture);

		const material = new MeshBasicNodeMaterial({
			transparent: true,
			// Ensure we can see the inside of the sphere through the holes.
			side: THREE.DoubleSide,
		}) as ExplosionMaterial;

		// Noise lookup drifts with life so the dissolve churns rather than just
		// eroding a fixed pattern.
		const noiseUv = uv().add(vec2(uLife.mul(0.2), uLife.mul(0.2)));

		material.positionNode = Fn(() => {
			const n = tNoise.sample(noiseUv).r;

			// Displace vertices to make it look jagged and irregular.
			const displaced = positionLocal.add(normalLocal.mul(n.mul(0.8)));

			// Expand over time (ease-out).
			const scale = float(1.0)
				.sub(pow(float(1.0).sub(uLife), 3.0))
				.mul(1.5)
				.add(0.5);
			return displaced.mul(scale);
		})();

		material.colorNode = Fn(() => {
			const n = tNoise.sample(noiseUv).r.toVar();

			// Threshold goes from -0.2 to 1.2 to dissolve the sphere.
			const threshold = uLife.mul(1.4).sub(0.2);
			n.lessThan(threshold).discard();

			const edgeDist = n.sub(threshold).toVar();

			// Toon explosion colour palette.
			const colorFire = vec3(1.0, 0.9, 0.0);   // Bright yellow core
			const colorOrange = vec3(1.0, 0.4, 0.0); // Orange inner border
			const colorDark = vec3(0.2, 0.05, 0.0);  // Dark burnt red/brown outer edge

			const finalColor = vec3(colorFire).toVar();
			If(edgeDist.lessThan(0.1), () => {
				// Outer edge
				finalColor.assign(mix(colorDark, colorOrange, edgeDist.div(0.1)));
			}).ElseIf(edgeDist.lessThan(0.3), () => {
				// Inner border
				finalColor.assign(
					mix(colorOrange, colorFire, edgeDist.sub(0.1).div(0.2))
				);
			});
			return finalColor;
		})();

		// The update loop drives life through here; keeping the node on the
		// material is what lets one shared update path reach every live explosion.
		material.uLife = uLife;
		return material;
	}

	emit(position: THREE.Vector3) {
		const geometry = new THREE.SphereGeometry(1.0, 32, 32);
		const material = this.createMaterial();

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
				exp.material.uLife.value = exp.life / exp.maxLife;
			}
		}
	}
}
