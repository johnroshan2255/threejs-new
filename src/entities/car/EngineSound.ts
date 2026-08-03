import * as THREE from "three";

/**
 * Thar-style diesel off-roader: loud, throaty, clattery low end.
 * Pitch follows speed + throttle (no gear system).
 */
export class EngineSound {
	private ctx: AudioContext | null = null;
	private oscBass: OscillatorNode | null = null;
	private oscBody: OscillatorNode | null = null;
	private oscClack: OscillatorNode | null = null;
	private noiseSrc: AudioBufferSourceNode | null = null;
	private noiseGain: GainNode | null = null;
	private bodyFilter: BiquadFilterNode | null = null;
	private exhaustFilter: BiquadFilterNode | null = null;
	private masterGain: GainNode | null = null;
	private panner: PannerNode | null = null;
	private started = false;
	private is3D = false;

	constructor(is3D = false) {
		this.is3D = is3D;
	}

	async init() {
		if (this.ctx || this.started) return;
		this.started = true;

		try {
			this.ctx = THREE.AudioContext.getContext() as AudioContext;
			const t = this.ctx.currentTime;

			this.masterGain = this.ctx.createGain();
			this.masterGain.gain.value = 0;

			if (this.is3D) {
				this.panner = this.ctx.createPanner();
				this.panner.panningModel = "HRTF";
				this.panner.distanceModel = "inverse";
				this.panner.refDistance = 8;
				this.panner.maxDistance = 120;
				this.panner.rolloffFactor = 1.1;
				this.masterGain.connect(this.panner);
				this.panner.connect(this.ctx.destination);
			} else {
				this.masterGain.connect(this.ctx.destination);
			}

			this.oscBass = this.ctx.createOscillator();
			this.oscBass.type = "sawtooth";
			this.oscBass.frequency.value = 36;

			this.oscBody = this.ctx.createOscillator();
			this.oscBody.type = "triangle";
			this.oscBody.frequency.value = 68;

			this.oscClack = this.ctx.createOscillator();
			this.oscClack.type = "square";
			this.oscClack.frequency.value = 95;

			const bassGain = this.ctx.createGain();
			bassGain.gain.value = 0.7;

			const bodyGain = this.ctx.createGain();
			bodyGain.gain.value = 0.45;

			const clackGain = this.ctx.createGain();
			clackGain.gain.value = 0.07;

			this.bodyFilter = this.ctx.createBiquadFilter();
			this.bodyFilter.type = "lowpass";
			this.bodyFilter.frequency.value = 520;
			this.bodyFilter.Q.value = 1.1;

			this.exhaustFilter = this.ctx.createBiquadFilter();
			this.exhaustFilter.type = "bandpass";
			this.exhaustFilter.frequency.value = 160;
			this.exhaustFilter.Q.value = 0.75;

			const noiseBuf = this.ctx.createBuffer(
				1,
				this.ctx.sampleRate * 2,
				this.ctx.sampleRate
			);
			const data = noiseBuf.getChannelData(0);
			for (let i = 0; i < data.length; i++) {
				data[i] = (Math.random() * 2 - 1) * (0.4 + 0.2 * Math.sin(i * 0.013));
			}
			this.noiseSrc = this.ctx.createBufferSource();
			this.noiseSrc.buffer = noiseBuf;
			this.noiseSrc.loop = true;
			this.noiseGain = this.ctx.createGain();
			this.noiseGain.gain.value = 0.08;

			const noiseFilter = this.ctx.createBiquadFilter();
			noiseFilter.type = "lowpass";
			noiseFilter.frequency.value = 480;
			noiseFilter.Q.value = 0.8;

			this.oscBass.connect(bassGain);
			this.oscBody.connect(bodyGain);
			this.oscClack.connect(clackGain);
			bassGain.connect(this.bodyFilter);
			bodyGain.connect(this.bodyFilter);
			clackGain.connect(this.bodyFilter);
			this.bodyFilter.connect(this.masterGain);

			this.noiseSrc.connect(noiseFilter);
			noiseFilter.connect(this.exhaustFilter);
			this.exhaustFilter.connect(this.noiseGain);
			this.noiseGain.connect(this.masterGain);

			this.oscBass.start(t);
			this.oscBody.start(t);
			this.oscClack.start(t);
			this.noiseSrc.start(t);
		} catch (e) {
			console.warn("Failed to init AudioContext", e);
		}
	}

	update(speed: number, throttle: number, position?: THREE.Vector3, muted = false) {
		if (
			!this.ctx ||
			!this.masterGain ||
			!this.oscBass ||
			!this.oscBody ||
			!this.oscClack ||
			!this.noiseGain ||
			!this.bodyFilter ||
			!this.exhaustFilter
		) {
			return;
		}

		if (this.ctx.state === "suspended") {
			this.ctx.resume();
		}

		if (this.is3D && this.panner && position) {
			this.panner.positionX.setTargetAtTime(position.x, this.ctx.currentTime, 0.12);
			this.panner.positionY.setTargetAtTime(position.y, this.ctx.currentTime, 0.12);
			this.panner.positionZ.setTargetAtTime(position.z, this.ctx.currentTime, 0.12);
		}

		const t = this.ctx.currentTime;
		const absThrottle = Math.abs(throttle);

		if (muted) {
			this.masterGain.gain.setTargetAtTime(0, t, 0.06);
			return;
		}

		const speedNorm = Math.min(1, speed / 22);
		const load = absThrottle;
		const pitch = Math.max(0.04, speedNorm * 0.75 + load * 0.35);

		const fBass = 28 + pitch * 48;
		const fBody = 52 + pitch * 82;
		const fClack = 78 + pitch * 110;

		this.oscBass.frequency.setTargetAtTime(fBass, t, 0.06);
		this.oscBody.frequency.setTargetAtTime(fBody, t, 0.055);
		this.oscClack.frequency.setTargetAtTime(fClack, t, 0.05);

		const cutoff = 340 + speedNorm * 380 + absThrottle * 260;
		this.bodyFilter.frequency.setTargetAtTime(cutoff, t, 0.08);
		this.exhaustFilter.frequency.setTargetAtTime(120 + speedNorm * 140, t, 0.1);

		const noiseVol = 0.06 + absThrottle * 0.12 + speedNorm * 0.05;
		this.noiseGain.gain.setTargetAtTime(noiseVol, t, 0.08);

		const idleVol = 0.12;
		const loadVol = absThrottle * 0.32;
		const speedVol = speedNorm * 0.14;
		let targetVolume = idleVol + loadVol + speedVol;
		if (absThrottle < 0.02) {
			targetVolume = idleVol + speedNorm * 0.06;
		}

		this.masterGain.gain.setTargetAtTime(Math.min(0.72, targetVolume), t, 0.08);
	}

	dispose() {
		try {
			this.oscBass?.stop();
			this.oscBody?.stop();
			this.oscClack?.stop();
			this.noiseSrc?.stop();
		} catch {
			/* already stopped */
		}
		this.oscBass?.disconnect();
		this.oscBody?.disconnect();
		this.oscClack?.disconnect();
		this.noiseSrc?.disconnect();
		this.noiseGain?.disconnect();
		this.bodyFilter?.disconnect();
		this.exhaustFilter?.disconnect();
		this.masterGain?.disconnect();
		this.panner?.disconnect();

		this.ctx = null;
		this.oscBass = null;
		this.oscBody = null;
		this.oscClack = null;
		this.noiseSrc = null;
		this.noiseGain = null;
		this.bodyFilter = null;
		this.exhaustFilter = null;
		this.masterGain = null;
		this.panner = null;
	}
}
