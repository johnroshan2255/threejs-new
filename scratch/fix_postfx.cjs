const fs = require('fs');

let mainTs = fs.readFileSync('src/main.ts', 'utf8');

// 1. Replace the setPostFxEnabled function
const setPostFxStart = mainTs.indexOf('private async setPostFxEnabled(enabled: boolean) {');
if (setPostFxStart !== -1) {
    const setPostFxEnd = mainTs.indexOf('}', setPostFxStart) + 1;
    const newSetPostFx = `private async setPostFxEnabled(enabled: boolean) {
		this.postFxEnabled = enabled;
		if (enabled) {
			this.renderer.toneMapping = THREE.NoToneMapping;
		} else {
			this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
			this.renderer.toneMappingExposure = 1.0;
		}
	}`;
    mainTs = mainTs.substring(0, setPostFxStart) + newSetPostFx + mainTs.substring(setPostFxEnd);
    console.log("Replaced setPostFxEnabled.");
} else {
    console.error("Could not find setPostFxEnabled!");
}

// 2. Replace the composer.render call
const renderCallStr = `		if (!this.postFxTransitioning) {
			this.composer?.render(dt);`;

const newRenderCall = `		if (!this.postFxTransitioning) {
			if (this.postFxEnabled && this.composer) {
				this.composer.render(dt);
			} else {
				this.renderer.render(this.scene, this.camera);
			}`;

// Use indexOf to find and replace to avoid CRLF mismatch issues
const renderIdx = mainTs.indexOf(`this.composer?.render(dt);`);
if (renderIdx !== -1) {
    mainTs = mainTs.substring(0, renderIdx) + 
             `if (this.postFxEnabled && this.composer) {\n\t\t\t\tthis.composer.render(dt);\n\t\t\t} else {\n\t\t\t\tthis.renderer.render(this.scene, this.camera);\n\t\t\t}` + 
             mainTs.substring(renderIdx + `this.composer?.render(dt);`.length);
    console.log("Replaced composer.render.");
} else {
    console.error("Could not find this.composer?.render(dt);");
}

fs.writeFileSync('src/main.ts', mainTs);
console.log("Applied postfx toggle");
