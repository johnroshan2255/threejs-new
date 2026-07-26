import * as THREE from 'three';

export class BombSound {
	static playThrowSound(position: THREE.Vector3) {
		const ctx = THREE.AudioContext.getContext() as AudioContext;
		if (!ctx) return;
		
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		const panner = ctx.createPanner();
		
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = 5;
		panner.maxDistance = 100;
		panner.positionX.value = position.x;
		panner.positionY.value = position.y;
		panner.positionZ.value = position.z;
		
		// Thicker sweeping pitch for throw (whoosh sound)
		osc.type = 'triangle';
		osc.frequency.setValueAtTime(120, ctx.currentTime);
		osc.frequency.exponentialRampToValueAtTime(350, ctx.currentTime + 0.3);
		
		gain.gain.setValueAtTime(1.2, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
		
		osc.connect(gain);
		gain.connect(panner);
		panner.connect(ctx.destination);
		
		osc.start();
		osc.stop(ctx.currentTime + 0.4);
	}
	
	static playBlastSound(position: THREE.Vector3) {
		const ctx = THREE.AudioContext.getContext() as AudioContext;
		if (!ctx) return;
		
		const panner = ctx.createPanner();
		panner.panningModel = 'HRTF';
		panner.distanceModel = 'inverse';
		panner.refDistance = 20; // Explosions carry very far
		panner.maxDistance = 500;
		panner.positionX.value = position.x;
		panner.positionY.value = position.y;
		panner.positionZ.value = position.z;

		// 1. Intense White Noise Crunch
		const bufferSize = ctx.sampleRate * 2; // 2 seconds
		const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < bufferSize; i++) {
			// Multiply by 3 to intentionally clip the noise for a crunchy explosion
			data[i] = (Math.random() * 2 - 1) * 3.0; 
		}
		
		const noise = ctx.createBufferSource();
		noise.buffer = buffer;
		
		// Filter allows high end crackle at start, then quickly muffles into a deep rumble
		const filter = ctx.createBiquadFilter();
		filter.type = 'lowpass';
		filter.frequency.setValueAtTime(4000, ctx.currentTime);
		filter.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 1.0);
		
		const noiseGain = ctx.createGain();
		noiseGain.gain.setValueAtTime(3.0, ctx.currentTime); // Very loud initial attack
		noiseGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.5);
		
		noise.connect(filter);
		filter.connect(noiseGain);
		noiseGain.connect(panner);
		
		// 2. Heavy Sub-Bass Impact
		const subOsc = ctx.createOscillator();
		subOsc.type = 'sine';
		// Sweeps from chest-thumping 100Hz down to inaudible 10Hz
		subOsc.frequency.setValueAtTime(100, ctx.currentTime);
		subOsc.frequency.exponentialRampToValueAtTime(10, ctx.currentTime + 1.0);
		
		const subGain = ctx.createGain();
		subGain.gain.setValueAtTime(4.0, ctx.currentTime); // Massive bass boost
		subGain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1.2);
		
		subOsc.connect(subGain);
		subGain.connect(panner);
		panner.connect(ctx.destination);
		
		// Start both
		noise.start();
		subOsc.start();
		
		noise.stop(ctx.currentTime + 2.0);
		subOsc.stop(ctx.currentTime + 2.0);
	}
}
