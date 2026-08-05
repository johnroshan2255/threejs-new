const fs = require('fs');

let mainTs = fs.readFileSync('src/main.ts', 'utf8');

// Replace the render call
const oldRender = `		if (!this.postFxTransitioning) {
			this.composer?.render(dt);`;
const newRender = `		if (!this.postFxTransitioning) {
			if (this.postFxEnabled && this.composer) {
				this.composer.render(dt);
			} else {
				this.renderer.render(this.scene, this.camera);
			}`;
if (mainTs.includes(oldRender)) {
    mainTs = mainTs.replace(oldRender, newRender);
} else {
    console.error("Could not find oldRender");
}

// Replace the setPostFxEnabled function
const oldSetPostFx = `	private async setPostFxEnabled(enabled: boolean) {
		this.postFxEnabled = enabled;
	}`;
const newSetPostFx = `	private async setPostFxEnabled(enabled: boolean) {
		this.postFxEnabled = enabled;
		if (enabled) {
			this.renderer.toneMapping = THREE.NoToneMapping;
		} else {
			this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
			this.renderer.toneMappingExposure = 1.0;
		}
	}`;

if (mainTs.includes(oldSetPostFx)) {
    mainTs = mainTs.replace(oldSetPostFx, newSetPostFx);
} else {
    // try fallback for setPostFx
    const oldSetPostFxFallback = `private async setPostFxEnabled(enabled: boolean) {\r\n\t\tthis.postFxEnabled = enabled;\r\n\t}`;
    if (mainTs.includes(oldSetPostFxFallback)) {
        mainTs = mainTs.replace(oldSetPostFxFallback, newSetPostFx);
    } else {
        console.error("Could not find oldSetPostFx");
    }
}

fs.writeFileSync('src/main.ts', mainTs);
console.log("Applied postfx toggle");
