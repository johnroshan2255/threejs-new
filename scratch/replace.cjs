const fs = require('fs');
let code = fs.readFileSync('src/main.ts', 'utf8');

// 1. Add postprocessing imports
code = code.replace(
    '} from "./environment/VolumetricFogPass";',
    } from "./environment/VolumetricFogPass";
import { EffectComposer, RenderPass, EffectPass, GodRaysEffect, BloomEffect, VignetteEffect, ToneMappingEffect, ToneMappingMode, BlendFunction } from "postprocessing";
);

// 2. Replace class properties
code = code.replace(
    'private volumetricFogPass: VolumetricFogPass | null = null;',
    private composer: EffectComposer | null = null;
	private godRaysEffect: GodRaysEffect | null = null;
	private bloomEffect: BloomEffect | null = null;
	private vignetteEffect: VignetteEffect | null = null;
	private toneMappingEffect: ToneMappingEffect | null = null;
	private sunMesh: THREE.Mesh | null = null;
);

// 3. Setup composer in constructor
const setupOld = \		this.volumetricFogPass = new VolumetricFogPass();
		this.volumetricFogPass.setSize(
			window.innerWidth * this.renderer.getPixelRatio(),
			window.innerHeight * this.renderer.getPixelRatio()
		);
		this.volumetricFogPass.setQuality(this.graphicsQuality);\;

const setupNew = \		this.sunMesh = new THREE.Mesh(
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
		this.composer.addPass(effectPass);\;

code = code.replace(setupOld, setupNew);

// 4. Remove grading calls
const gradingRegex = /if \\(this\\.volumetricFogPass\\) \\{[^]*?this\\.volumetricFogPass\\.setVignette\\(t\\.vignette\\);\\s*\\}\\s*\\}/;
code = code.replace(gradingRegex, \\);

// 5. Replace render call
code = code.replace(
    /this\\.volumetricFogPass\\?\\.render\\([\\s\\S]*?\\);/,
    \	his.composer?.render(dt);\
);

// 6. Update sun position in render loop
code = code.replace(
    'this.syncVolumetricFogFrame(now * 0.001);',
    \	his.syncVolumetricFogFrame(now * 0.001);
			if (this.sunMesh) {
				this.sunMesh.position.copy(this.dayNight.getSunDirection()).multiplyScalar(400);
			}\
);

// 7. Replace resize and samples logic
code = code.replace(
    /this\\.volumetricFogPass\\?\\.setSize\\([^]*?\\);/,
    \	his.composer?.setSize(window.innerWidth, window.innerHeight);\
);

code = code.replace(
    'const multisampled = (this.volumetricFogPass?.sceneSamples ?? 0) > 1;',
    'const multisampled = (this.composer?.multisampling ?? 0) > 1;'
);

code = code.replace(
    'if (this.volumetricFogPass) this.volumetricFogPass.enabled = false;',
    ''
);

code = code.replace(
    'if (this.volumetricFogPass) this.volumetricFogPass.enabled = true;',
    ''
);


fs.writeFileSync('src/main.ts', code, 'utf8');
