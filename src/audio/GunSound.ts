import * as THREE from "three";

/** Procedural gunshot — no asset file required. */
export class GunSound {
	static playShot(position?: THREE.Vector3) {
		const ctx = THREE.AudioContext.getContext() as AudioContext;
		if (!ctx) return;
		if (ctx.state === "suspended") void ctx.resume();

		const now = ctx.currentTime;
		const master = ctx.createGain();
		master.gain.value = 0.85;
		master.connect(ctx.destination);

		if (position) {
			const panner = ctx.createPanner();
			panner.panningModel = "HRTF";
			panner.distanceModel = "inverse";
			panner.refDistance = 4;
			panner.maxDistance = 80;
			panner.positionX.value = position.x;
			panner.positionY.value = position.y;
			panner.positionZ.value = position.z;
			master.disconnect();
			master.connect(panner);
			panner.connect(ctx.destination);
		}

		// Sharp noise crack
		const dur = 0.12;
		const frames = Math.floor(ctx.sampleRate * dur);
		const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < frames; i++) {
			const env = 1 - i / frames;
			data[i] = (Math.random() * 2 - 1) * env * env;
		}
		const noise = ctx.createBufferSource();
		noise.buffer = buffer;
		const filter = ctx.createBiquadFilter();
		filter.type = "bandpass";
		filter.frequency.setValueAtTime(1800, now);
		filter.frequency.exponentialRampToValueAtTime(400, now + 0.08);
		filter.Q.value = 0.7;
		const noiseGain = ctx.createGain();
		noiseGain.gain.setValueAtTime(1.4, now);
		noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
		noise.connect(filter);
		filter.connect(noiseGain);
		noiseGain.connect(master);

		// Body thump
		const thump = ctx.createOscillator();
		thump.type = "sine";
		thump.frequency.setValueAtTime(140, now);
		thump.frequency.exponentialRampToValueAtTime(45, now + 0.09);
		const thumpGain = ctx.createGain();
		thumpGain.gain.setValueAtTime(0.9, now);
		thumpGain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
		thump.connect(thumpGain);
		thumpGain.connect(master);

		noise.start(now);
		thump.start(now);
		noise.stop(now + dur);
		thump.stop(now + 0.12);
	}
}
