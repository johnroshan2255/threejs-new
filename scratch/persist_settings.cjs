const fs = require('fs');

let mainTs = fs.readFileSync('src/main.ts', 'utf8');

// We will insert loadSettings() and saveSettings() right before setupSettings()
const setupSettingsStart = mainTs.indexOf('	private setupSettings() {');

if (setupSettingsStart !== -1) {
    const persistenceMethods = `	private loadSettings() {
		try {
			const saved = localStorage.getItem('game_settings');
			if (saved) {
				const parsed = JSON.parse(saved);
				if (parsed.shadowQuality) this.shadowQuality = parsed.shadowQuality;
				if (parsed.resolutionQuality) this.resolutionQuality = parsed.resolutionQuality;
				if (parsed.waterQuality) this.waterQuality = parsed.waterQuality;
				if (parsed.postFxEnabled !== undefined) this.postFxEnabled = parsed.postFxEnabled;
				if (parsed.period) this.dayNightGui.period = parsed.period;
				if (parsed.autoDayNight !== undefined) this.dayNightGui.auto = parsed.autoDayNight;
				if (parsed.hour !== undefined) this.dayNightGui.hour = parsed.hour;
				if (parsed.grassDensity !== undefined) this.grassDensity = parsed.grassDensity;
				if (parsed.grassCullDistance !== undefined) this.grassCullDistance = parsed.grassCullDistance;
				if (parsed.carPower !== undefined) CAR_CONFIG.drive.engineForce = parsed.carPower;
			}
		} catch (e) {
			console.warn("Failed to load settings from localStorage", e);
		}
	}

	private saveSettings() {
		try {
			const toSave = {
				shadowQuality: this.shadowQuality,
				resolutionQuality: this.resolutionQuality,
				waterQuality: this.waterQuality,
				postFxEnabled: this.postFxEnabled,
				period: this.dayNightGui.period,
				autoDayNight: this.dayNightGui.auto,
				hour: this.dayNightGui.hour,
				grassDensity: this.grassDensity,
				grassCullDistance: this.grassCullDistance,
				carPower: CAR_CONFIG.drive.engineForce
			};
			localStorage.setItem('game_settings', JSON.stringify(toSave));
		} catch (e) {
			console.warn("Failed to save settings to localStorage", e);
		}
	}

`;
    mainTs = mainTs.substring(0, setupSettingsStart) + persistenceMethods + mainTs.substring(setupSettingsStart);
    console.log("Injected save/load methods");
} else {
    console.error("Could not find setupSettings");
}

// Next, add this.loadSettings() at the top of setupSettings()
mainTs = mainTs.replace(
	'	private setupSettings() {\n\t\tthis.settings = new GameSettings({',
	'	private setupSettings() {\n\t\tthis.loadSettings();\n\t\tthis.settings = new GameSettings({'
);

// We want to add this.saveSettings() into all the callbacks in setupSettings.
// The easiest way is to wrap all those assignments.
// Or we can just do a regex replace on the specific setupSettings block.
const setupSettingsEnd = mainTs.indexOf('this.applyShadowQuality(this.shadowQuality);', setupSettingsStart);
if (setupSettingsEnd !== -1) {
	let block = mainTs.substring(setupSettingsStart, setupSettingsEnd);
	
	block = block.replace(/onShadowQualityChange: \(quality\) => this\.applyShadowQuality\(quality\),/,
						  'onShadowQualityChange: (quality) => { this.applyShadowQuality(quality); this.saveSettings(); },');
	
	block = block.replace(/onResolutionQualityChange: \(quality\) => this\.applyResolutionQuality\(quality\),/,
						  'onResolutionQualityChange: (quality) => { this.applyResolutionQuality(quality); this.saveSettings(); },');
	
	block = block.replace(/onWaterQualityChange: \(quality\) => this\.applyWaterQuality\(quality\),/,
						  'onWaterQualityChange: (quality) => { this.applyWaterQuality(quality); this.saveSettings(); },');
						  
	block = block.replace(/onPostFxChange: \(enabled\) => void this\.setPostFxEnabled\(enabled\),/,
						  'onPostFxChange: (enabled) => { this.setPostFxEnabled(enabled); this.saveSettings(); },');
						  
	block = block.replace(/this\.settings\.setAutoDayNight\(false\);\r?\n\t\t\t},/g,
						  'this.settings.setAutoDayNight(false);\n\t\t\t\tthis.saveSettings();\n\t\t\t},');
						  
	block = block.replace(/if \(this\.dayNight\) this\.dayNight\.auto = enabled;\r?\n\t\t\t},/,
						  'if (this.dayNight) this.dayNight.auto = enabled;\n\t\t\t\tthis.saveSettings();\n\t\t\t},');
						  
	block = block.replace(/onGrassDensityChange: \(percent\) => this\.setGrassDensity\(percent\),/,
						  'onGrassDensityChange: (percent) => { this.setGrassDensity(percent); this.saveSettings(); },');
						  
	block = block.replace(/onGrassCullDistanceChange: \(meters\) => this\.setGrassCullDistance\(meters\),/,
						  'onGrassCullDistanceChange: (meters) => { this.setGrassCullDistance(meters); this.saveSettings(); },');
						  
	block = block.replace(/CAR_CONFIG\.drive\.engineForce = power;\r?\n\t\t\t},/,
						  'CAR_CONFIG.drive.engineForce = power;\n\t\t\t\tthis.saveSettings();\n\t\t\t},');
						  
	mainTs = mainTs.substring(0, setupSettingsStart) + block + mainTs.substring(setupSettingsEnd);
	console.log("Injected saveSettings into callbacks");
} else {
	console.error("Could not find end of setupSettings block");
}


// One more place: when postFxEnabled is initially loaded, we must also apply the initial ToneMapping state correctly before the render loop!
// But wait, setPostFxEnabled handles tone mapping logic. If we just call `this.setPostFxEnabled(this.postFxEnabled)` it will sync it.
// We can add it after `this.applyWaterQuality(this.waterQuality);`
mainTs = mainTs.replace(
	'this.applyWaterQuality(this.waterQuality);',
	'this.applyWaterQuality(this.waterQuality);\n\t\tthis.setPostFxEnabled(this.postFxEnabled);'
);

fs.writeFileSync('src/main.ts', mainTs);
console.log("Applied persistent settings");
