const fs = require('fs');

let mainTs = fs.readFileSync('src/main.ts', 'utf8');

// 1. Imports
mainTs = mainTs.replace(
	'type GraphicsQuality,',
	'type QualityLevel,'
);

// 2. State vars
mainTs = mainTs.replace(
	'private graphicsQuality: GraphicsQuality = "High";',
	'private shadowQuality: QualityLevel = "High";\n\tprivate resolutionQuality: QualityLevel = "High";\n\tprivate waterQuality: QualityLevel = "High";'
);

// 3. GameSettings initialization
mainTs = mainTs.replace(
	'quality: "High",',
	'shadowQuality: this.shadowQuality,\n\t\t\tresolutionQuality: this.resolutionQuality,\n\t\t\twaterQuality: this.waterQuality,'
);

// 4. Callbacks
mainTs = mainTs.replace(
	'onQualityChange: (quality) => this.applyGraphicsQuality(quality),',
	'onShadowQualityChange: (quality) => this.applyShadowQuality(quality),\n\t\t\tonResolutionQualityChange: (quality) => this.applyResolutionQuality(quality),\n\t\t\tonWaterQualityChange: (quality) => this.applyWaterQuality(quality),'
);

// 5. Initial application
mainTs = mainTs.replace(
	'this.applyGraphicsQuality(this.graphicsQuality);',
	'this.applyShadowQuality(this.shadowQuality);\n\t\tthis.applyResolutionQuality(this.resolutionQuality);\n\t\tthis.applyWaterQuality(this.waterQuality);'
);

// 6. Replace the entire applyGraphicsQuality method block EXACTLY.
const oldFunc = `	private applyGraphicsQuality(quality: GraphicsQuality) {
		this.graphicsQuality = quality;
		const pixelRatio =
			quality === "Low" ? 0.75 : quality === "Medium" ? 1 : 2;
		const shadowsEnabled = quality !== "Low";
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatio));
		this.renderer.shadowMap.enabled = shadowsEnabled;
		this.renderer.shadowMap.autoUpdate = quality === "High";
		if (shadowsEnabled) this.renderer.shadowMap.needsUpdate = true;
		// The shadow box has to span the visible range (200 m) to avoid a moving
		// cutoff, so resolution carries the crispness: 4096 over 400 m gives
		// ~0.098 m texels, about what 2048 over 180 m used to.
		this.dayNight?.setShadowQuality(quality === "High" ? 4096 : 2048, 200);
		this.grassMaterial.updateGrassGraphicsChange(quality === "High");
		this.waterUpdateInterval =
			quality === "Low" ? 4 : quality === "Medium" ? 3 : 2;
		this.waterFrameCounter = 0;
		this.waterDeltaAccumulator = 0;
		this.editorWaterFrameCounter = 0;
		this.editorWaterDeltaAccumulator = 0;
		this.resizePondTargets();
		const pr = this.renderer.getPixelRatio();
		this.composer?.setSize(window.innerWidth, window.innerHeight);
		this.syncVolumetricFogQuality();
		
	}`;

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

if (mainTs.includes(oldFunc)) {
	mainTs = mainTs.replace(oldFunc, newFuncs);
	console.log("Successfully replaced applyGraphicsQuality.");
} else {
	console.error("STILL COULD NOT FIND applyGraphicsQuality EXACT STRING! Replacing via substring fallback.");
    // Fallback: slice it out if exact string fails due to CRLF
    const startIndex = mainTs.indexOf('private applyGraphicsQuality(quality: GraphicsQuality) {');
    const endIndex = mainTs.indexOf('this.syncVolumetricFogQuality();', startIndex);
    if (startIndex !== -1 && endIndex !== -1) {
        const fullEndIndex = mainTs.indexOf('}', endIndex) + 1;
        mainTs = mainTs.slice(0, startIndex) + newFuncs + mainTs.slice(fullEndIndex);
        console.log("Replaced via fallback slice.");
    } else {
        console.error("FALLBACK ALSO FAILED.");
    }
}

// 7. General replacements of remaining \`graphicsQuality\` checks to \`resolutionQuality\`
mainTs = mainTs.replace(/this\.graphicsQuality/g, 'this.resolutionQuality');

fs.writeFileSync('src/main.ts', mainTs);
console.log("Refactored main.ts graphics successfully");
