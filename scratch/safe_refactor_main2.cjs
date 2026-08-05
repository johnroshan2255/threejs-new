const fs = require('fs');

let mainTs = fs.readFileSync('src/main.ts', 'utf8');

// The function we want to replace
const oldFuncRegex = /private\s+applyGraphicsQuality[\s\S]*?this\.syncVolumetricFogQuality\(\);\r?\n\t\}/;

const newFuncs = `	private applyShadowQuality(quality: QualityLevel) {
		this.shadowQuality = quality;
		const shadowsEnabled = quality !== "Low";
		this.renderer.shadowMap.enabled = shadowsEnabled;
		this.renderer.shadowMap.autoUpdate = quality === "High";
		if (shadowsEnabled) this.renderer.shadowMap.needsUpdate = true;
		this.dayNight?.setShadowQuality(quality === "High" ? 4096 : 2048, 200);
		this.grassMaterial.updateGrassGraphicsChange(quality === "High");
	}

	private applyResolutionQuality(quality: QualityLevel) {
		this.resolutionQuality = quality;
		const pixelRatio =
			quality === "Low" ? 0.75 : quality === "Medium" ? 1 : 2;
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatio));
		this.resizePondTargets();
		this.composer?.setSize(window.innerWidth, window.innerHeight);
		this.syncVolumetricFogQuality();
	}

	private applyWaterQuality(quality: QualityLevel) {
		this.waterQuality = quality;
		this.waterUpdateInterval =
			quality === "Low" ? 4 : quality === "Medium" ? 3 : 2;
		this.waterFrameCounter = 0;
		this.waterDeltaAccumulator = 0;
		this.editorWaterFrameCounter = 0;
		this.editorWaterDeltaAccumulator = 0;
	}`;

if (oldFuncRegex.test(mainTs)) {
	mainTs = mainTs.replace(oldFuncRegex, newFuncs);
	fs.writeFileSync('src/main.ts', mainTs);
	console.log("Successfully replaced applyGraphicsQuality using regex.");
} else {
	console.error("STILL COULD NOT FIND applyGraphicsQuality!");
}
