const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

const setupOld = `		this.volumetricFogPass = new VolumetricFogPass();
		this.volumetricFogPass.setSize(
			window.innerWidth * this.renderer.getPixelRatio(),
			window.innerHeight * this.renderer.getPixelRatio()
		);
		this.volumetricFogPass.setQuality(this.graphicsQuality);`;
const setupNew = `		this.sunMesh = new THREE.Mesh(
			new THREE.SphereGeometry(30, 32, 32),
			new THREE.MeshBasicMaterial({ color: 0xffffee, fog: false })
		);
		this.sunMesh.frustumCulled = false;
		this.scene.add(this.sunMesh);

		this.composer = new EffectComposer(this.renderer, {
			multisampling: Math.min(4, this.renderer.capabilities.maxSamples)
		});
		
		const renderPass = new RenderPass(this.scene, this.camera);
		
		this.godRaysEffect = new GodRaysEffect(this.camera, this.sunMesh, {
			resolutionScale: 0.5,
			density: 0.96,
			decay: 0.95,
			weight: 0.3,
			exposure: 0.6,
			samples: 60,
			clampMax: 1.0,
			blendFunction: BlendFunction.SCREEN
		});

		this.bloomEffect = new BloomEffect({
			blendFunction: BlendFunction.ADD,
			luminanceThreshold: 0.7,
			luminanceSmoothing: 0.2,
			intensity: 1.0
		});

		this.vignetteEffect = new VignetteEffect({
			eskil: false,
			offset: 0.1,
			darkness: 0.5
		});

		this.toneMappingEffect = new ToneMappingEffect({
			mode: ToneMappingMode.ACES_FILMIC,
			resolution: 256,
			whitePoint: 4.0,
			middleGrey: 0.6,
			minLuminance: 0.01,
			averageLuminance: 0.01
		});

		const effectPass = new EffectPass(this.camera, this.godRaysEffect, this.bloomEffect, this.vignetteEffect, this.toneMappingEffect);
		this.composer.addPass(renderPass);
		this.composer.addPass(effectPass);`;

code = code.replace(setupOld, setupNew);
code = code.replace(/const pass = this\.volumetricFogPass;/g, '');
code = code.replace(/this\.scene\.fog\.density = this\.volumetricFogPass\?\.enabled[^;]*;/g, 'this.scene.fog.density = 0;');
code = code.replace(/passEnabled: this\.volumetricFogPass\?\.enabled \?\? false,/g, 'passEnabled: true,');
code = code.replace(/this\.volumetricFogPass\?\.setSize\([\s\S]*?\);/g, 'this.composer?.setSize(window.innerWidth, window.innerHeight);');

fs.writeFileSync('src/main.ts', code, 'utf8');
