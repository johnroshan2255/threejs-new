import * as THREE from 'three';

export class EngineSound {
  private ctx: AudioContext | null = null;
  private osc1: OscillatorNode | null = null;
  private osc2: OscillatorNode | null = null;
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
      
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0; // start muted
      
      if (this.is3D) {
        this.panner = this.ctx.createPanner();
        this.panner.panningModel = 'HRTF';
        this.panner.distanceModel = 'inverse';
        this.panner.refDistance = 5;
        this.panner.maxDistance = 100;
        this.panner.rolloffFactor = 1.5;
        this.masterGain.connect(this.panner);
        this.panner.connect(this.ctx.destination);
      } else {
        this.masterGain.connect(this.ctx.destination);
      }

      // Low frequency hum
      this.osc1 = this.ctx.createOscillator();
      this.osc1.type = 'sawtooth';
      this.osc1.frequency.value = 40;
      
      // Higher frequency whine for RPM
      this.osc2 = this.ctx.createOscillator();
      this.osc2.type = 'triangle';
      this.osc2.frequency.value = 80;

      const gain1 = this.ctx.createGain();
      gain1.gain.value = 0.5;
      
      const gain2 = this.ctx.createGain();
      gain2.gain.value = 0.3;

      this.osc1.connect(gain1);
      this.osc2.connect(gain2);

      gain1.connect(this.masterGain);
      gain2.connect(this.masterGain);

      this.osc1.start();
      this.osc2.start();

    } catch(e) {
      console.warn("Failed to init AudioContext", e);
    }
  }

  update(speed: number, throttle: number, position?: THREE.Vector3) {
    if (!this.ctx || !this.masterGain || !this.osc1 || !this.osc2) return;

    // Must resume context if browser suspended it
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    if (this.is3D && this.panner && position) {
      this.panner.positionX.setTargetAtTime(position.x, this.ctx.currentTime, 0.1);
      this.panner.positionY.setTargetAtTime(position.y, this.ctx.currentTime, 0.1);
      this.panner.positionZ.setTargetAtTime(position.z, this.ctx.currentTime, 0.1);
    }

    const maxSpeed = 30; // Max speed for tuning pitch
    const normalizedSpeed = Math.min(speed / maxSpeed, 1.0);
    const absThrottle = Math.abs(throttle);

    // Engine pitch goes up with speed, and spikes when throttle is applied
    const baseFreq1 = 40;
    const baseFreq2 = 80;
    
    // Calculate RPM factor (combination of speed and throttle load)
    const rpmFactor = normalizedSpeed + (absThrottle * 0.5);

    // Smooth frequency updates
    const f1 = baseFreq1 + (rpmFactor * 100);
    const f2 = baseFreq2 + (rpmFactor * 200);

    this.osc1.frequency.setTargetAtTime(f1, this.ctx.currentTime, 0.1);
    this.osc2.frequency.setTargetAtTime(f2, this.ctx.currentTime, 0.1);

    // Only play sound if actively accelerating (throttle > 0)
    let targetVolume = 0;
    if (absThrottle > 0.01) {
      targetVolume = 0.1 + (absThrottle * 0.15) + (normalizedSpeed * 0.05);
    }
    
    this.masterGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.1);
  }

  dispose() {
    if (this.osc1) {
      this.osc1.stop();
      this.osc1.disconnect();
    }
    if (this.osc2) {
      this.osc2.stop();
      this.osc2.disconnect();
    }
    if (this.masterGain) this.masterGain.disconnect();
    if (this.panner) this.panner.disconnect();
    
    // DO NOT CLOSE SHARED CONTEXT!
    
    this.ctx = null;
    this.osc1 = null;
    this.osc2 = null;
    this.masterGain = null;
    this.panner = null;
  }
}
