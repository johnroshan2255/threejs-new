import * as THREE from 'three';

export class HornSound {
	private ctx: AudioContext | null = null;
	private masterGain: GainNode | null = null;
	private osc1: OscillatorNode | null = null;
	private osc2: OscillatorNode | null = null;
	public isPlaying: boolean = false;

	constructor() {
		this.ctx = THREE.AudioContext.getContext() as AudioContext;
		if (!this.ctx) return;

		this.masterGain = this.ctx.createGain();
		this.masterGain.gain.value = 0;
		// A car horn is quite loud, but we'll limit it so it doesn't blow speakers
		this.masterGain.connect(this.ctx.destination);
	}

	public play() {
		if (!this.ctx || !this.masterGain || this.isPlaying) return;
		this.isPlaying = true;

		// Create new oscillators each time
		this.osc1 = this.ctx.createOscillator();
		this.osc2 = this.ctx.createOscillator();

		// Sawtooth gives that harsh, buzzy tone of a car horn
		this.osc1.type = 'sawtooth';
		this.osc2.type = 'sawtooth';

		// Frequencies of a standard dual-tone car horn (roughly F4 and A4)
		this.osc1.frequency.value = 349.23; // F4
		this.osc2.frequency.value = 440.00; // A4

		this.osc1.connect(this.masterGain);
		this.osc2.connect(this.masterGain);

		this.osc1.start();
		this.osc2.start();

		// Quick fade in
		this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.masterGain.gain.setValueAtTime(0, this.ctx.currentTime);
		this.masterGain.gain.linearRampToValueAtTime(0.3, this.ctx.currentTime + 0.05);
	}

	public stop() {
		if (!this.ctx || !this.masterGain || !this.isPlaying) return;
		this.isPlaying = false;

		// Quick fade out to avoid popping
		this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
		this.masterGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.1);

		if (this.osc1 && this.osc2) {
			this.osc1.stop(this.ctx.currentTime + 0.1);
			this.osc2.stop(this.ctx.currentTime + 0.1);
		}
	}
}
