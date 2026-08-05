import re
import sys

with open('src/main.ts', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Imports
code = code.replace(
    '} from "./environment/VolumetricFogPass";',
    '} from "./environment/VolumetricFogPass";\nimport { EffectComposer, RenderPass, EffectPass, GodRaysEffect, BloomEffect, VignetteEffect, ToneMappingEffect, ToneMappingMode, BlendFunction } from "postprocessing";'
)

# 2. Properties
code = code.replace(
    'private volumetricFogPass: VolumetricFogPass | null = null;',
    'private composer: EffectComposer | null = null;\n\tprivate godRaysEffect: GodRaysEffect | null = null;\n\tprivate bloomEffect: BloomEffect | null = null;\n\tprivate vignetteEffect: VignetteEffect | null = null;\n\tprivate toneMappingEffect: ToneMappingEffect | null = null;\n\tprivate sunMesh: THREE.Mesh | null = null;'
)

# 3. Setup
setup_old = """		this.volumetricFogPass = new VolumetricFogPass();
		this.volumetricFogPass.setSize(
			window.innerWidth * this.renderer.getPixelRatio(),
			window.innerHeight * this.renderer.getPixelRatio()
		);
		this.volumetricFogPass.setQuality(this.graphicsQuality);"""
setup_new = """		this.sunMesh = new THREE.Mesh(
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
		this.composer.addPass(effectPass);"""
code = code.replace(setup_old, setup_new)

# 4. Grading
grading_pattern = r'if \(this\.volumetricFogPass\) \{.*?\this\.volumetricFogPass\.setVignette\(t\.vignette\);\n\s*\}\n\s*\}'
code = re.sub(grading_pattern, '', code, flags=re.DOTALL)

# 5. Render
render_pattern = r'this\.volumetricFogPass\?\.render\([\s\S]*?\);'
code = re.sub(render_pattern, 'this.composer?.render(dt);', code)

# 6. Resize
code = code.replace(
    'this.volumetricFogPass?.setSize(',
    '// this.volumetricFogPass?.setSize('
)
code = code.replace(
    'window.innerWidth * pr,',
    '// window.innerWidth * pr,'
)
code = code.replace(
    'window.innerHeight * pr',
    '// window.innerHeight * pr'
)
code = code.replace('this.resizePondTargets();', 'this.resizePondTargets();\n\t\tthis.composer?.setSize(window.innerWidth, window.innerHeight);')

# 7. Quality Sync (Empty it)
code = re.sub(r'private syncVolumetricFogQuality\(\) \{.*?(?=^\s+private syncVolumetricFogFrame)', r'private syncVolumetricFogQuality() {\n\t\tconst multisampled = (this.composer?.multisampling ?? 0) > 1;\n\t\tthis.grassMaterial.setAlphaToCoverage(multisampled);\n\t\tsetFoliageAlphaToCoverage(multisampled, this.scene);\n\t}\n\n', code, flags=re.DOTALL | re.MULTILINE)

# 8. Frame Sync
sync_frame = r'if \(!pass\?\.enabled \|\| !this\.dayNight\) return;'
code = re.sub(r'const pass = this\.volumetricFogPass;\n\s*if \(!pass\?\.enabled \|\| !this\.dayNight\) return;', 'if (!this.dayNight) return;', code)

# 9. Update sun position inside syncVolumetricFogFrame
code = code.replace(
    'const override = this.dayNight.overrideColors;',
    'if (this.sunMesh) this.sunMesh.position.copy(this.dayNight.getSunDirection()).multiplyScalar(400);\n\t\tconst override = this.dayNight.overrideColors;'
)

# 10. setPostFxEnabled
postfx_pattern = r'private async setPostFxEnabled\(enabled: boolean\) \{.*?(?=^\s+private syncAlphaToCoverage)'
code = re.sub(postfx_pattern, 'private async setPostFxEnabled(enabled: boolean) {\n\t\tthis.postFxEnabled = enabled;\n\t}\n\n', code, flags=re.DOTALL | re.MULTILINE)

# 11. Remove syncAlphaToCoverage (since we moved it to syncVolumetricFogQuality)
alpha_cov = r'private syncAlphaToCoverage\(\) \{.*?(?=^\s+private syncVolumetricFogQuality)'
code = re.sub(alpha_cov, '', code, flags=re.DOTALL | re.MULTILINE)

# 12. Suppress fog mode
code = code.replace('passEnabled: this.volumetricFogPass?.enabled ?? false,', 'passEnabled: true,')
code = code.replace('this.scene.fog.density = this.volumetricFogPass?.enabled\n\t\t\t\t\t? this.residualFogDensity\n\t\t\t\t\t: this.atmosphereFogDensity;', 'this.scene.fog.density = this.atmosphereFogDensity;')

with open('src/main.ts', 'w', encoding='utf-8') as f:
    f.write(code)

print("Done")
