import * as THREE from "three";
import { createGlowSprites } from "./glowSprites";
import { getWorldTerrainY } from "../terrain/islandHeight";

export type LampFireflyGlow = {
	points: THREE.Object3D;
	/** World position of the glow (tweak x/y/z to place it). */
	position: THREE.Vector3;
	setIntensity: (amount: number) => void;
	dispose: () => void;
};

function makeSoftGlowTexture(): THREE.Texture {
	const size = 128;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d")!;
	const g = ctx.createRadialGradient(
		size / 2,
		size / 2,
		0,
		size / 2,
		size / 2,
		size / 2
	);
	g.addColorStop(0, "rgba(255,255,200,1)");
	g.addColorStop(0.2, "rgba(220,255,120,0.9)");
	g.addColorStop(0.5, "rgba(180,255,80,0.35)");
	g.addColorStop(1, "rgba(0,0,0,0)");
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, size, size);

	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.needsUpdate = true;
	return tex;
}

/**
 * One large firefly-style additive glow (same look as night bugs, much bigger).
 * Place at lamp lantern height; intensity driven by evening/night.
 */
export function createLampFireflyGlow(options: {
	x: number;
	z: number;
	/** Height above terrain (meters). Default ≈ lantern on a ~8 m post. */
	heightAboveGround?: number;
	/** Point size in world units (fireflies use ~0.2–0.5). */
	size?: number;
}): LampFireflyGlow {
	const heightAboveGround = options.heightAboveGround ?? 7.5;
	const size = options.size ?? 4.5;
	const groundY = getWorldTerrainY(options.x, options.z);
	const position = new THREE.Vector3(
		options.x,
		groundY + heightAboveGround,
		options.z
	);

	const glowTex = makeSoftGlowTexture();
	const glow = createGlowSprites({
		positions: new Float32Array([position.x, position.y, position.z]),
		texture: glowTex,
		color: "#d8ff66",
		size,
	});

	const points = glow.mesh;
	points.name = "lamp-firefly-glow";
	points.renderOrder = 3;
	points.visible = false;

	const syncPosition = () => {
		glow.offsets.setXYZ(0, position.x, position.y, position.z);
		glow.offsets.needsUpdate = true;
	};

	return {
		points,
		position,
		setIntensity(amount: number) {
			const a = THREE.MathUtils.clamp(amount, 0, 1);
			const visible = a > 0.05;
			points.visible = visible;
			if (!visible) {
				glow.setOpacity(0);
				return;
			}
			syncPosition();
			glow.setSize(size * (0.85 + a * 0.35));
			glow.setOpacity(THREE.MathUtils.clamp(a * 0.95, 0, 1));
		},
		dispose() {
			points.removeFromParent();
			glow.dispose();
			glowTex.dispose();
		},
	};
}
