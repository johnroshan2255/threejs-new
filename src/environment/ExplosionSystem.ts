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
	attribute,
} from 'three/tsl';

export class ExplosionSystem {
	public mesh: THREE.InstancedMesh;
	private textureLoader = new THREE.TextureLoader();
	private noiseTexture: THREE.Texture;
	private maxInstances = 20;
	private currentIndex = 0;
	private startTimes: Float32Array;
	private uTime = uniform(0);
	private dummy = new THREE.Object3D();

	constructor() {
		// Load noise texture for the dissolve effect
		this.noiseTexture = this.textureLoader.load('/perlinnoise.webp');
		this.noiseTexture.wrapS = THREE.RepeatWrapping;
		this.noiseTexture.wrapT = THREE.RepeatWrapping;

		const geometry = new THREE.SphereGeometry(1.0, 32, 32);
		this.startTimes = new Float32Array(this.maxInstances);
		this.startTimes.fill(-10000); // Start off dead

		const startTimeAttr = new THREE.InstancedBufferAttribute(this.startTimes, 1);
		startTimeAttr.setUsage(THREE.DynamicDrawUsage);
		geometry.setAttribute('aStartTime', startTimeAttr);

		const positions = new Float32Array(this.maxInstances * 3);
		// Initialize them far away to prevent flashes at origin
		for(let i = 0; i < this.maxInstances; i++) {
			positions[i*3 + 1] = -1000;
		}
		const centerPosAttr = new THREE.InstancedBufferAttribute(positions, 3);
		centerPosAttr.setUsage(THREE.DynamicDrawUsage);
		geometry.setAttribute('aCenterPos', centerPosAttr);

		const material = this.createMaterial();

		this.mesh = new THREE.InstancedMesh(geometry, material, this.maxInstances);
		this.mesh.count = this.maxInstances;
		this.mesh.frustumCulled = false;
	}

	/**
	 * Compute life entirely on the GPU.
	 */
	private createMaterial(): MeshBasicNodeMaterial {
		const tNoise = texture(this.noiseTexture);

		const material = new MeshBasicNodeMaterial({
			transparent: true,
			// Ensure we can see the inside of the sphere through the holes.
			side: THREE.DoubleSide,
		});

		const aStartTime = attribute('aStartTime', 'float');
		const rawLife = this.uTime.sub(aStartTime as any) as any;
		// clamp life for visual calculations
		const uLife = rawLife.clamp(0.0, 1.0) as any;

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
			
			// If life is out of bounds (dead), collapse to 0
			const finalScale = rawLife.greaterThan(1.0).or(rawLife.lessThan(0.0))
				.select(float(0.0), scale);

			// Instead of instanceMatrix, add the custom aCenterPos
			const aCenterPos = attribute('aCenterPos', 'vec3');
			return aCenterPos.add(displaced.mul(finalScale));
		})();

		material.colorNode = Fn(() => {
			const n = tNoise.sample(noiseUv).r.toVar();

			// Threshold goes from -0.2 to 1.2 to dissolve the sphere.
			const threshold = uLife.mul(1.4).sub(0.2);
			
			// Discard if noise < threshold or if dead
			n.lessThan(threshold).or(rawLife.greaterThan(1.0)).or(rawLife.lessThan(0.0)).discard();

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

		return material;
	}

	emit(position: THREE.Vector3) {
		const idx = this.currentIndex;
		this.currentIndex = (this.currentIndex + 1) % this.maxInstances;

		const posAttr = this.mesh.geometry.getAttribute('aCenterPos') as THREE.InstancedBufferAttribute;
		posAttr.setXYZ(idx, position.x, position.y, position.z);
		posAttr.needsUpdate = true;

		this.startTimes[idx] = this.uTime.value;
		const timeAttr = this.mesh.geometry.getAttribute('aStartTime') as THREE.InstancedBufferAttribute;
		timeAttr.needsUpdate = true;
	}

	update(dt: number) {
		this.uTime.value += dt;
	}
}
