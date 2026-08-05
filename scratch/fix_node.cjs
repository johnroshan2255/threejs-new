const fs = require('fs');

let code = fs.readFileSync('src/main.ts', 'utf8');

// 1. Imports
code = code.replace(
    '} from "./environment/VolumetricFogPass";',
    '} from "./environment/VolumetricFogPass";\nimport { EffectComposer, RenderPass, EffectPass, GodRaysEffect, BloomEffect, VignetteEffect, ToneMappingEffect, ToneMappingMode, BlendFunction } from "postprocessing";'
);

// 2. Properties
code = code.replace(
    'private volumetricFogPass: VolumetricFogPass | null = null;',
    'private composer: EffectComposer | null = null;\n\tprivate godRaysEffect: GodRaysEffect | null = null;\n\tprivate bloomEffect: BloomEffect | null = null;\n\tprivate vignetteEffect: VignetteEffect | null = null;\n\tprivate toneMappingEffect: ToneMappingEffect | null = null;\n\tprivate sunMesh: THREE.Mesh | null = null;'
);

// 3. Setup
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

// 4. Grading
const gradingRegex = /if \(this\.volumetricFogPass\) \{[\s\S]*?this\.volumetricFogPass\.setVignette\(t\.vignette\);\s*\}\s*\}/;
code = code.replace(gradingRegex, '');

// 5. Render
const renderRegex = /this\.volumetricFogPass\?\.render\([\s\S]*?\);/;
code = code.replace(renderRegex, 'this.composer?.render(dt);');

// 6. Resize
code = code.replace('this.volumetricFogPass?.setSize(', '// this.volumetricFogPass?.setSize(');
code = code.replace('window.innerWidth * pr,', '// window.innerWidth * pr,');
code = code.replace('window.innerHeight * pr', '// window.innerHeight * pr');
code = code.replace('this.resizePondTargets();', 'this.resizePondTargets();\n\t\tthis.composer?.setSize(window.innerWidth, window.innerHeight);');

// 7. Quality Sync
const syncQualityRegex = /private syncVolumetricFogQuality\(\) \{[\s\S]*?(?=^\s*private syncVolumetricFogFrame)/m;
const newSyncQuality = `private syncVolumetricFogQuality() {
		const multisampled = (this.composer?.multisampling ?? 0) > 1;
		this.grassMaterial.setAlphaToCoverage(multisampled);
		setFoliageAlphaToCoverage(multisampled, this.scene);
	}

	`;
code = code.replace(syncQualityRegex, newSyncQuality);

// 8. Frame Sync
code = code.replace(/const pass = this\.volumetricFogPass;\n\s*if \(!pass\?\.enabled \|\| !this\.dayNight\) return;/, 'if (!this.dayNight) return;');

// 9. Update sun position
code = code.replace(
    'const override = this.dayNight.overrideColors;',
    'if (this.sunMesh) this.sunMesh.position.copy(this.dayNight.getSunDirection()).multiplyScalar(400);\n\t\tconst override = this.dayNight.overrideColors;'
);

// 10. setPostFxEnabled
const postFxRegex = /private async setPostFxEnabled\(enabled: boolean\) \{[\s\S]*?(?=^\s*private syncAlphaToCoverage)/m;
const newPostFx = `private async setPostFxEnabled(enabled: boolean) {
		this.postFxEnabled = enabled;
	}

	`;
code = code.replace(postFxRegex, newPostFx);

// 11. Remove syncAlphaToCoverage
const alphaCovRegex = /private syncAlphaToCoverage\(\) \{[\s\S]*?(?=^\s*private syncVolumetricFogQuality)/m;
code = code.replace(alphaCovRegex, '');

// 12. Fix remaining volumetricFogPass errors
code = code.replace(/passEnabled: this\.volumetricFogPass\?\.enabled \?\? false,/g, 'passEnabled: true,');
code = code.replace(/this\.scene\.fog\.density = this\.volumetricFogPass\?\.enabled[\s\S]*?: this\.atmosphereFogDensity;/g, 'this.scene.fog.density = this.atmosphereFogDensity;');
code = code.replace(/this\.volumetricFogPass \? this\.residualFogDensity : this\.atmosphereFogDensity;/g, 'this.atmosphereFogDensity;');

code = code.replace(/this\.volumetricFogPass\?\.enabled/g, 'true');

// More fixes for any missed parts
code = code.replace(/this\.syncAlphaToCoverage\(\);/g, '');

fs.writeFileSync('src/main.ts', code, 'utf8');
console.log("Done");
