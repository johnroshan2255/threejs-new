import * as THREE from 'three';

export class NitroSound {
	private ctx: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private filter: BiquadFilterNode | null = null;
	private noiseSource: AudioBufferSourceNode | null = null;
	public isPlaying: boolean = false;

	constructor() {
		this.ctx = THREE.AudioContext.getContext() as AudioContext;
		if (!this.ctx) return;

		this.masterGain = this.ctx.createGain();
		this.masterGain.gain.value = 0;
		this.masterGain.connect(this.ctx.destination);
	}

	private createNoiseBuffer(): AudioBuffer | null {
		if (!this.ctx) return null;
		const bufferSize = this.ctx.sampleRate * 2; // 2 seconds of noise
		const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
		const output = buffer.getChannelData(0);
		for (let i = 0; i < bufferSize; i++) {
			output[i] = Math.random() * 2 - 1;
		}
		return buffer;
	}

	public play() {
		if (!this.ctx || !this.masterGain || this.isPlaying) return;
		this.isPlaying = true;

		this.filter = this.ctx.createBiquadFilter();
		this.filter.type = 'lowpass';
		this.filter.Q.value = 1.0;
		// Sweep frequency up for a jet thruster sound, but milder
		this.filter.frequency.setValueAtTime(200, this.ctx.currentTime);
		this.filter.frequency.exponentialRampToValueAtTime(2000, this.ctx.currentTime + 0.4);
		this.filter.connect(this.masterGain);

		const noiseBuffer = this.createNoiseBuffer();
		if (noiseBuffer) {
			this.noiseSource = this.ctx.createBufferSource();
			this.noiseSource.buffer = noiseBuffer;
			this.noiseSource.loop = true;
			this.noiseSource.connect(this.filter);
			this.noiseSource.start();
		}

		// Fade in (much milder volume)
		this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
		this.masterGain.gain.linearRampToValueAtTime(0.15, this.ctx.currentTime + 0.15);
	}

	public stop() {
		if (!this.ctx || !this.masterGain || !this.isPlaying) return;
		this.isPlaying = false;

		this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
		this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.4);

		if (this.noiseSource) {
			this.noiseSource.stop(this.ctx.currentTime + 0.4);
			this.noiseSource = null;
		}
	}
}
