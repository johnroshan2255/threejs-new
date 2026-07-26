import * as THREE from 'three';

export class ExplosionSystem {
	public mesh: THREE.Group;
	private explosions: { mesh: THREE.Mesh, material: THREE.ShaderMaterial, life: number, maxLife: number }[] = [];
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
		
		const material = new THREE.ShaderMaterial({
			uniforms: {
				tNoise: { value: this.noiseTexture },
				uLife: { value: 0.0 }
			},
			vertexShader: `
				uniform sampler2D tNoise;
				uniform float uLife;
				varying vec2 vUv;
				
				void main() {
					vUv = uv;
					
					// Add some movement to the noise lookup based on life
					vec2 noiseUv = uv + vec2(uLife * 0.2, uLife * 0.2);
					float n = texture2D(tNoise, noiseUv).r;
					
					// Displace vertices to make it look jagged and irregular
					vec3 newPos = position + normal * (n * 0.8);
					
					// Expand over time (ease-out)
					float scale = 0.5 + (1.0 - pow(1.0 - uLife, 3.0)) * 1.5;
					newPos *= scale;
					
					vec4 mvPosition = modelViewMatrix * vec4(newPos, 1.0);
					gl_Position = projectionMatrix * mvPosition;
				}
			`,
			fragmentShader: `
				uniform sampler2D tNoise;
				uniform float uLife;
				varying vec2 vUv;
				
				void main() {
					vec2 noiseUv = vUv + vec2(uLife * 0.2, uLife * 0.2);
					float n = texture2D(tNoise, noiseUv).r;
					
					// Threshold goes from -0.2 to 1.2 to dissolve the sphere
					float threshold = (uLife * 1.4) - 0.2;
					
					if (n < threshold) {
						discard;
					}
					
					float edgeDist = n - threshold;
					
					// Toon explosion color palette
					vec3 colorFire = vec3(1.0, 0.9, 0.0);   // Bright yellow core
					vec3 colorOrange = vec3(1.0, 0.4, 0.0); // Orange inner border
					vec3 colorDark = vec3(0.2, 0.05, 0.0);  // Dark burnt red/brown outer edge
					
					vec3 finalColor;
					if (edgeDist < 0.1) {
						// Outer edge
						finalColor = mix(colorDark, colorOrange, edgeDist / 0.1);
					} else if (edgeDist < 0.3) {
						// Inner border
						finalColor = mix(colorOrange, colorFire, (edgeDist - 0.1) / 0.2);
					} else {
						// Core
						finalColor = colorFire;
					}
					
					gl_FragColor = vec4(finalColor, 1.0);
				}
			`,
			transparent: true,
			side: THREE.DoubleSide // Ensure we can see the inside of the sphere through the holes
		});

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
				exp.material.uniforms.uLife.value = lifeRatio;
			}
		}
	}
}
