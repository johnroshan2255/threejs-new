import * as THREE from "three";

/**
 * Dual-filter ("dual Kawase") bloom.
 *
 * Chosen over UnrealBloomPass deliberately: that pass runs a separable gaussian
 * with 5 blur materials over 5 mips (~30+ taps per pixel per level). This does a
 * 5-tap downsample and an 8-tap tent upsample over a half-res mip chain, which
 * gets a *wider*, smoother glow for roughly a third of the bandwidth.
 *
 * Feed it a linear-HDR source; the mips are HalfFloat so values above 1.0
 * survive and actually bloom.
 */
export class BloomChain {
	/** Half-res and down. Index 0 is the largest, and holds the final result. */
	private mips: THREE.WebGLRenderTarget[] = [];
	private levels = 5;
	private width = 1;
	private height = 1;

	private readonly fsScene = new THREE.Scene();
	private readonly fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
	private readonly quad: THREE.Mesh;

	private readonly prefilterMat: THREE.ShaderMaterial;
	private readonly downMat: THREE.ShaderMaterial;
	private readonly upMat: THREE.ShaderMaterial;

	constructor() {
		const vertexShader = /* glsl */ `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = vec4(position.xy, 0.0, 1.0);
			}
		`;

		// Bright-pass + first halving. Soft knee keeps the bloom from popping on
		// as surfaces cross the threshold.
		this.prefilterMat = new THREE.ShaderMaterial({
			uniforms: {
				tSrc: { value: null as THREE.Texture | null },
				uTexel: { value: new THREE.Vector2() },
				uThreshold: { value: 0.75 },
				uSoftKnee: { value: 0.6 },
				uClamp: { value: 12.0 },
			},
			vertexShader,
			fragmentShader: /* glsl */ `
				precision highp float;
				uniform sampler2D tSrc;
				uniform vec2 uTexel;
				uniform float uThreshold;
				uniform float uSoftKnee;
				uniform float uClamp;
				varying vec2 vUv;

				/**
				 * Inverse-luma ("Karis") weight.
				 *
				 * This is what stops bloom flicker. A plain box average lets one very
				 * bright sub-pixel highlight — a distant grass tip, a water specular,
				 * a firefly — dominate the whole tap group. As the camera moves, that
				 * highlight lands on a tap one frame and between taps the next, so its
				 * bloom blob switches on and off: a light blinking in the distance.
				 * Weighting by 1/(1+luma) bounds any single pixel's contribution, so
				 * the average changes smoothly instead of popping.
				 */
				float karisWeight(vec3 c) {
					return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)));
				}

				void main() {
					vec2 o = uTexel;

					// 3x3 at source-texel spacing: band-limits the 2x downsample so
					// there is no frequency left to alias in the first place.
					vec3 s0 = min(texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb, vec3(uClamp));
					vec3 s1 = min(texture2D(tSrc, vUv + vec2( 0.0, -o.y)).rgb, vec3(uClamp));
					vec3 s2 = min(texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb, vec3(uClamp));
					vec3 s3 = min(texture2D(tSrc, vUv + vec2(-o.x,  0.0)).rgb, vec3(uClamp));
					vec3 s4 = min(texture2D(tSrc, vUv).rgb,                    vec3(uClamp));
					vec3 s5 = min(texture2D(tSrc, vUv + vec2( o.x,  0.0)).rgb, vec3(uClamp));
					vec3 s6 = min(texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb, vec3(uClamp));
					vec3 s7 = min(texture2D(tSrc, vUv + vec2( 0.0,  o.y)).rgb, vec3(uClamp));
					vec3 s8 = min(texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb, vec3(uClamp));

					float w0 = karisWeight(s0);
					float w1 = karisWeight(s1) * 2.0;
					float w2 = karisWeight(s2);
					float w3 = karisWeight(s3) * 2.0;
					float w4 = karisWeight(s4) * 4.0;
					float w5 = karisWeight(s5) * 2.0;
					float w6 = karisWeight(s6);
					float w7 = karisWeight(s7) * 2.0;
					float w8 = karisWeight(s8);

					vec3 sum = s0 * w0 + s1 * w1 + s2 * w2
						+ s3 * w3 + s4 * w4 + s5 * w5
						+ s6 * w6 + s7 * w7 + s8 * w8;
					float wsum = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8;
					vec3 c = sum / max(wsum, 1e-4);

					float br = max(c.r, max(c.g, c.b));
					float knee = uThreshold * uSoftKnee + 1e-5;
					float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
					soft = soft * soft / (4.0 * knee + 1e-5);
					float contrib = max(soft, br - uThreshold) / max(br, 1e-5);

					gl_FragColor = vec4(c * contrib, 1.0);
				}
			`,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		});

		this.downMat = new THREE.ShaderMaterial({
			uniforms: {
				tSrc: { value: null as THREE.Texture | null },
				uHalfTexel: { value: new THREE.Vector2() },
			},
			vertexShader,
			fragmentShader: /* glsl */ `
				precision highp float;
				uniform sampler2D tSrc;
				uniform vec2 uHalfTexel;
				varying vec2 vUv;

				void main() {
					vec2 h = uHalfTexel;
					vec3 sum = texture2D(tSrc, vUv).rgb * 4.0;
					sum += texture2D(tSrc, vUv - h).rgb;
					sum += texture2D(tSrc, vUv + h).rgb;
					sum += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb;
					sum += texture2D(tSrc, vUv - vec2(h.x, -h.y)).rgb;
					gl_FragColor = vec4(sum / 8.0, 1.0);
				}
			`,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		});

		this.upMat = new THREE.ShaderMaterial({
			uniforms: {
				tSrc: { value: null as THREE.Texture | null },
				uHalfTexel: { value: new THREE.Vector2() },
			},
			vertexShader,
			fragmentShader: /* glsl */ `
				precision highp float;
				uniform sampler2D tSrc;
				uniform vec2 uHalfTexel;
				varying vec2 vUv;

				void main() {
					vec2 h = uHalfTexel;
					vec3 sum = texture2D(tSrc, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
					sum += texture2D(tSrc, vUv + vec2(-h.x, h.y)).rgb * 2.0;
					sum += texture2D(tSrc, vUv + vec2(0.0, h.y * 2.0)).rgb;
					sum += texture2D(tSrc, vUv + vec2(h.x, h.y)).rgb * 2.0;
					sum += texture2D(tSrc, vUv + vec2(h.x * 2.0, 0.0)).rgb;
					sum += texture2D(tSrc, vUv + vec2(h.x, -h.y)).rgb * 2.0;
					sum += texture2D(tSrc, vUv + vec2(0.0, -h.y * 2.0)).rgb;
					sum += texture2D(tSrc, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
					gl_FragColor = vec4(sum / 12.0, 1.0);
				}
			`,
			// Accumulate onto the downsampled level already in the target.
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false,
			toneMapped: false,
		});

		this.quad = new THREE.Mesh(
			new THREE.PlaneGeometry(2, 2),
			this.prefilterMat
		);
		this.quad.frustumCulled = false;
		this.fsScene.add(this.quad);
	}

	/** 5 levels on High, 4 on Medium, 3 on Low. */
	setLevels(levels: number) {
		const next = Math.max(2, Math.min(6, Math.floor(levels)));
		if (next === this.levels) return;
		this.levels = next;
		this.rebuild();
	}

	setSize(width: number, height: number) {
		const w = Math.max(1, Math.floor(width));
		const h = Math.max(1, Math.floor(height));
		if (w === this.width && h === this.height) return;
		this.width = w;
		this.height = h;
		this.rebuild();
	}

	private rebuild() {
		for (const rt of this.mips) rt.dispose();
		this.mips = [];

		for (let i = 0; i < this.levels; i++) {
			const div = 2 ** (i + 1);
			const w = Math.max(1, Math.floor(this.width / div));
			const h = Math.max(1, Math.floor(this.height / div));
			const rt = new THREE.WebGLRenderTarget(w, h, {
				format: THREE.RGBAFormat,
				type: THREE.HalfFloatType,
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				depthBuffer: false,
				stencilBuffer: false,
			});
			rt.texture.wrapS = THREE.ClampToEdgeWrapping;
			rt.texture.wrapT = THREE.ClampToEdgeWrapping;
			this.mips.push(rt);
			// Stop early if we've shrunk to nothing.
			if (w <= 2 || h <= 2) break;
		}
	}

	/**
	 * Runs the chain and returns the bloom texture (half-res).
	 * Leaves the renderer's target/autoClear as it found them.
	 */
	render(
		renderer: THREE.WebGLRenderer,
		source: THREE.Texture,
		threshold: number,
		softKnee = 0.6
	): THREE.Texture | null {
		if (this.mips.length === 0) this.rebuild();
		if (this.mips.length === 0) return null;

		const prevTarget = renderer.getRenderTarget();
		const prevAutoClear = renderer.autoClear;

		this.prefilterMat.uniforms.tSrc.value = source;
		this.prefilterMat.uniforms.uThreshold.value = threshold;
		this.prefilterMat.uniforms.uSoftKnee.value = softKnee;
		// Full source-texel spacing — the 3x3 Karis tap group needs to span the
		// whole 2x footprint, not half of it.
		this.prefilterMat.uniforms.uTexel.value.set(
			1 / this.width,
			1 / this.height
		);

		renderer.autoClear = true;
		this.quad.material = this.prefilterMat;
		renderer.setRenderTarget(this.mips[0]);
		renderer.render(this.fsScene, this.fsCamera);

		// Downsample: mips[i-1] -> mips[i]
		this.quad.material = this.downMat;
		for (let i = 1; i < this.mips.length; i++) {
			const src = this.mips[i - 1];
			this.downMat.uniforms.tSrc.value = src.texture;
			this.downMat.uniforms.uHalfTexel.value.set(
				0.5 / src.width,
				0.5 / src.height
			);
			renderer.setRenderTarget(this.mips[i]);
			renderer.render(this.fsScene, this.fsCamera);
		}

		// Upsample additively: mips[i] -> mips[i-1], smallest first.
		this.quad.material = this.upMat;
		renderer.autoClear = false;
		for (let i = this.mips.length - 1; i > 0; i--) {
			const src = this.mips[i];
			this.upMat.uniforms.tSrc.value = src.texture;
			this.upMat.uniforms.uHalfTexel.value.set(
				0.5 / src.width,
				0.5 / src.height
			);
			renderer.setRenderTarget(this.mips[i - 1]);
			renderer.render(this.fsScene, this.fsCamera);
		}

		renderer.autoClear = prevAutoClear;
		renderer.setRenderTarget(prevTarget);

		return this.mips[0].texture;
	}

	dispose() {
		for (const rt of this.mips) rt.dispose();
		this.mips = [];
		this.prefilterMat.dispose();
		this.downMat.dispose();
		this.upMat.dispose();
		(this.quad.geometry as THREE.BufferGeometry).dispose();
	}
}
