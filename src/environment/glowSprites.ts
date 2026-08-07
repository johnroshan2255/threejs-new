import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import {
	cameraProjectionMatrix,
	float,
	attribute,
	materialColor,
	materialOpacity,
	max,
	min,
	modelViewMatrix,
	screenDPR,
	screenSize,
	sin,
	texture,
	uniform,
	uv,
	vec4,
} from "three/tsl";

/**
 * A cloud of camera-facing textured quads, addressed like a point cloud.
 *
 * WebGPU has no sized points. `THREE.Points` maps to the `point-list` topology,
 * where every point is exactly one pixel and there is no `gl_PointCoord` to
 * index a sprite with — so a `PointsMaterial` carrying a glow texture renders as
 * single invisible pixels rather than as soft dots. Billboarded instanced quads
 * are the portable equivalent, and `SpriteNodeMaterial` already does the
 * facing-the-camera part.
 *
 * The offset attribute is exposed directly so callers can animate positions the
 * same way they drove `geometry.attributes.position` before.
 */
export type GlowSprites = {
	mesh: THREE.Mesh;
	/** One xyz per sprite. Set `needsUpdate` after writing. */
	offsets: THREE.InstancedBufferAttribute;
	/** Sprite diameter, in the same units `PointsMaterial.size` used. */
	setSize: (size: number) => void;
	/** Group brightness. Per-sprite twinkle rides on top of this. */
	setOpacity: (opacity: number) => void;
	getOpacity: () => number;
	/** Drives the per-sprite pulse. No-op when the cloud has no phases. */
	setTime: (seconds: number) => void;
	dispose: () => void;
};

export function createGlowSprites(options: {
	positions: Float32Array;
	texture: THREE.Texture;
	color: THREE.ColorRepresentation;
	size: number;
	/**
	 * Per-sprite pulse phase (radians) and rate multiplier, interleaved as
	 * `[phase, rate, phase, rate, …]`.
	 *
	 * Omit for a steady glow. Supplying them is what keeps a swarm from reading
	 * as one lamp switching on and off: a single shared `material.opacity`
	 * multiplied by one global sine makes every sprite peak on the same frame,
	 * however many of them there are.
	 */
	pulse?: Float32Array;
	/** Base angular frequency of the pulse, rad/s. */
	pulseRate?: number;
	/** Half the peak-to-trough swing. 0 = steady, 0.28 = the authored twinkle. */
	pulseDepth?: number;
	/**
	 * Largest screen footprint a single sprite may occupy, in pixels.
	 *
	 * Omit to leave a sprite unbounded (correct for a deliberately large glow
	 * the player can walk up to). Set it for anything that can pass close to the
	 * camera — see the clamp below.
	 */
	maxScreenPx?: number;
}): GlowSprites {
	const count = options.positions.length / 3;

	const offsets = new THREE.InstancedBufferAttribute(options.positions, 3);
	offsets.setUsage(THREE.DynamicDrawUsage);

	const geometry = new THREE.InstancedBufferGeometry();
	geometry.instanceCount = count;
	// Unit quad centred on the origin; SpriteNodeMaterial reads position.xy as
	// the corner offset and places the centre at positionNode.
	geometry.setAttribute(
		"position",
		new THREE.Float32BufferAttribute(
			[-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
			3
		)
	);
	geometry.setAttribute(
		"uv",
		new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2)
	);
	geometry.setIndex([0, 1, 2, 0, 2, 3]);
	geometry.setAttribute("aOffset", offsets);

	const uSize = uniform(options.size);
	const uTime = uniform(0);

	const material = new SpriteNodeMaterial({
		color: new THREE.Color(options.color),
		transparent: true,
		opacity: 0,
		depthWrite: false,
		depthTest: false,
		blending: THREE.AdditiveBlending,
	});
	const offsetNode: any = attribute("aOffset", "vec3");
	material.positionNode = offsetNode;

	// Match the sizing convention these sprites were tuned against.
	//
	// `PointsMaterial` with sizeAttenuation sizes a point as
	// `size * (height/2) / distance` — independent of field of view. A true
	// world-space quad instead covers `size * P[1][1] * (height/2) / distance`,
	// so at this camera's 75° fov every sprite came out 1.30x wider (~1.7x the
	// area) than the art expected, which additive blending and bloom then
	// exaggerated further. Dividing by P[1][1] restores the original footprint
	// and keeps doing so if the fov ever changes.
	const projYY: any = (cameraProjectionMatrix as any)[1].y;
	let worldSize: any = uSize.mul(float(1).div(projYY));

	// Cap how much screen a single sprite may cover.
	//
	// A world-space quad grows as 1/distance with nothing to stop it, so one
	// firefly drifting past the chase camera covered most of the frame and,
	// being additive, blew out to white — a green flash that reads as a light
	// switching on. Hardware point sprites never did this because GL clamps
	// gl_PointSize to ALIASED_POINT_SIZE_RANGE, so the old code was bounded for
	// free. This is that clamp, expressed in world units:
	//   px = S * P[1][1] * H / (2 * dist)  =>  S(px) = 2 * dist * px / (P[1][1] * H)
	if (options.maxScreenPx) {
		const centreView: any = modelViewMatrix.mul(vec4(offsetNode, 1.0));
		const dist = max(centreView.z.negate(), float(0.001));
		// `screenSize` is the drawing buffer, so fold in the device pixel ratio to
		// keep the cap a CSS-pixel budget — otherwise the limit halves on a
		// Retina display and the sprites read differently per monitor.
		const capWorld = dist
			.mul(2 * options.maxScreenPx)
			.mul(screenDPR)
			.div(projYY.mul(screenSize.y));
		worldSize = min(worldSize, capWorld);
	}

	material.scaleNode = worldSize;

	const sprite = texture(options.texture, uv());
	material.colorNode = materialColor.mul(sprite.rgb) as any;

	let alpha: any = sprite.a.mul(materialOpacity);
	if (options.pulse) {
		const depth = options.pulseDepth ?? 0.28;
		const rate = options.pulseRate ?? 2.1;
		const pulseBuffer = new THREE.InstancedBufferAttribute(options.pulse, 2);
		geometry.setAttribute("aPulse", pulseBuffer);
		// phase = .x, per-sprite rate multiplier = .y
		const pulseAttr: any = attribute("aPulse", "vec2");
		const wave = sin(uTime.mul(rate).mul(pulseAttr.y).add(pulseAttr.x));
		alpha = alpha.mul(wave.mul(depth).add(1 - depth));
	}
	material.opacityNode = alpha;

	const mesh = new THREE.Mesh(geometry, material);
	// The quads are placed entirely by the shader, so the geometry's own bounds
	// describe a single unit quad at the origin and cannot be culled against.
	mesh.frustumCulled = false;

	return {
		mesh,
		offsets,
		setSize: (size) => {
			uSize.value = size;
		},
		setOpacity: (opacity) => {
			material.opacity = opacity;
		},
		getOpacity: () => material.opacity,
		setTime: (seconds) => {
			uTime.value = seconds;
		},
		dispose: () => {
			geometry.dispose();
			material.dispose();
		},
	};
}
