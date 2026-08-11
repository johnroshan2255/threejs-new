import * as THREE from "three";
import {
	Fn,
	materialColor,
	mix,
	normalWorld,
	positionWorld,
	smoothstep,
	step,
	texture,
} from "three/tsl";
import { snowUniforms } from "./snowMask";

/**
 * Shared snow shading term.
 *
 * Terrain, grass, foliage and stones each reach the GPU by a different route —
 * a hand-built blade material, an instanced foliage material, a patched stock
 * material — so the *math* is centralised here as one set of TSL functions they
 * all call. If snow looked subtly different on rocks than on the ground it would
 * read as a bug, and four copies of a smoothstep is how that happens.
 *
 * Under WebGL this was a GLSL string spliced in via onBeforeCompile /
 * CustomShaderMaterial. Nodes make the same sharing structural rather than
 * textual: one `Fn`, reused by reference.
 */

/** Mask UV for a world-space point. The world origin is the mask centre. */
export const snowMaskUV = /*#__PURE__*/ Fn(([worldPos]: [any]) =>
	worldPos.xz.div(snowUniforms.uSnowExtent).add(0.5)
);

/**
 * Raw coverage at a world point, 0..1.
 *
 * Outside the mask is bare ground, not clamped-edge snow smeared to infinity.
 * The bounds test is a product of steps rather than a branch so the texture
 * fetch stays outside any conditional — a sample inside divergent control flow
 * loses the implicit derivatives that pick its mip level.
 */
export const snowMaskAt = /*#__PURE__*/ Fn(([worldPos]: [any]) => {
	const uv = snowMaskUV(worldPos).toVar();
	const inside = step(0.0, uv.x)
		.mul(step(uv.x, 1.0))
		.mul(step(0.0, uv.y))
		.mul(step(uv.y, 1.0));
	return snowUniforms.uSnowMask
		.sample(uv)
		.r.mul(snowUniforms.uSnowStrength)
		.mul(inside);
});

/**
 * Coverage weighted by how upward-facing the surface is. This is what makes a
 * tint read as snow rather than white paint: snow rests on tops and never on
 * undersides or steep faces, so the silhouette stays dark where it should.
 */
export const snowAt = /*#__PURE__*/ Fn(([worldPos, upness]: [any, any]) =>
	snowMaskAt(worldPos).mul(smoothstep(0.25, 0.72, upness))
);

/** Uniform nodes, for materials that want to wire them up by name. */
export function snowShaderUniforms() {
	return {
		uSnowMask: snowUniforms.uSnowMask,
		uSnowExtent: snowUniforms.uSnowExtent,
		uSnowColor: snowUniforms.uSnowColor,
		uSnowStrength: snowUniforms.uSnowStrength,
	};
}

/**
 * Signature of the albedo inputs the patch was built for.
 *
 * `NodeMaterial` compiles `colorNode` once and caches the result, so the graph
 * has to be rebuilt whenever an input to it changes. `needsUpdate` alone is not
 * enough — assigning a *new* `colorNode` is what actually invalidates the cached
 * build. Storing the signature instead of a plain `true` flag makes repeat calls
 * free while still catching a material whose inputs moved under it.
 *
 * `vertexColors` is part of the signature even though `stockAlbedoNode` no
 * longer reads it: `NodeMaterial.setupDiffuseColor` appends its own
 * `vertexColor()` multiply at build time, so flipping the flag after the first
 * build has no effect until the graph is rebuilt. That is exactly how the
 * editor's terrain went white — vertex colours were switched on for road/water
 * paint, the cached graph kept returning the (now white) flat `.color`, and the
 * whole map rendered as blank paper.
 */
const SNOW_PATCH_FLAG = "snowPatched";

function albedoSignature(material: any): string {
	return `${material.map ? material.map.uuid : "-"}|${material.vertexColors ? 1 : 0}`;
}

/**
 * The albedo a stock material would have produced on its own, as a node.
 *
 * Overriding `colorNode` replaces the whole diffuse term, so whatever the stock
 * material was already doing for colour has to be rebuilt here or it silently
 * disappears. Stones arrive from a GLB with a map; terrain is a flat `.color`
 * the GUI can still change, which is why this reads `materialColor` — a live
 * reference — rather than baking the colour in at patch time.
 *
 * Vertex colours are deliberately *not* multiplied in here: three applies them
 * on top of whatever `colorNode` returns. Doing it here as well squared the
 * terrain's vertex colour and turned the ground near-black.
 */
function stockAlbedoNode(material: any) {
	let albedo: any = materialColor;
	if (material.map) albedo = albedo.mul(texture(material.map).rgb);
	return albedo;
}

/**
 * Add snow to a stock Three.js material (terrain Phong, stone GLB Standard).
 *
 * Patching the *shared* material is correct rather than a compromise: because
 * the mask is sampled per fragment by world position, one patched material
 * renders snowy and bare instances correctly at the same time. Sharing helps
 * here — patch once, every instance behaves locally.
 *
 * A stock material is converted to its node equivalent by
 * `NodeLibrary.fromMaterial`, which copies every enumerable property across, so
 * a `colorNode` assigned here survives the conversion. Callers keep their
 * existing material reference and type.
 */
export function applySnowToMaterial(material: THREE.Material) {
	const m = material as any;
	const signature = albedoSignature(m);
	if (m[SNOW_PATCH_FLAG] === signature) return;
	const firstPatch = m[SNOW_PATCH_FLAG] === undefined;
	m[SNOW_PATCH_FLAG] = signature;

	// A stock material accepts `colorNode` as an ordinary property and then
	// ignores it, so snow silently does nothing and the surface just never turns
	// white. That is exactly how terrain, cave rock and tree trunks lost their
	// snow: grass and foliage are node materials and kept working, which made it
	// look like a snow-mask bug rather than a material-type one.
	if (firstPatch && !m.isNodeMaterial) {
		console.warn(
			`[snow] ${material.type} "${material.name || "unnamed"}" is not a node ` +
				"material; colorNode is ignored and it will never show snow. Construct " +
				"it as the Mesh*NodeMaterial equivalent from 'three/webgpu'."
		);
	}

	m.colorNode = mix(
		stockAlbedoNode(m),
		snowUniforms.uSnowColor,
		snowAt(positionWorld, normalWorld.y)
	);
	m.needsUpdate = true;
}
