import * as THREE from "three";
import { createTree } from "../entities/tree";
import { placeStone } from "../entities/stone/placeStone";
import { resolveEditMesh } from "./meshCatalog";

const thumbnailCache = new Map<string, string>();
let generatorRenderer: THREE.WebGLRenderer | null = null;
let generatorScene: THREE.Scene | null = null;
let generatorCamera: THREE.PerspectiveCamera | null = null;

export async function generateMeshThumbnail(meshId: string): Promise<string> {
	if (thumbnailCache.has(meshId)) {
		return thumbnailCache.get(meshId)!;
	}

	if (!generatorRenderer) {
		const canvas = document.createElement("canvas");
		canvas.width = 128;
		canvas.height = 128;
		generatorRenderer = new THREE.WebGLRenderer({
			canvas,
			alpha: true,
			antialias: true,
			preserveDrawingBuffer: true,
		});
		generatorRenderer.outputColorSpace = THREE.SRGBColorSpace;
		generatorRenderer.toneMapping = THREE.ACESFilmicToneMapping;
		generatorRenderer.setSize(128, 128);

		generatorScene = new THREE.Scene();
		
		const ambient = new THREE.AmbientLight(0xffffff, 1.2);
		generatorScene.add(ambient);
		
		const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
		dirLight.position.set(5, 10, 5);
		generatorScene.add(dirLight);

		generatorCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
	}

	const catalog = resolveEditMesh(meshId);
	let meshObj: THREE.Object3D | null = null;
	let cleanup: (() => void) | null = null;

	if (catalog.kind === "stone") {
		const stone = await placeStone({
			position: new THREE.Vector3(0, 0, 0),
			scale: catalog.defaultScale ?? 1,
			rotationY: 0,
			assetUrl: catalog.assetUrl,
		});
		meshObj = stone.group;
		cleanup = () => stone.dispose();
	} else {
		const tree = await createTree({
			position: [0, 0, 0],
			placeOnTerrain: false,
			scale: catalog.defaultScale ?? 1,
			rotationY: 0,
			leafColor: "#3f6d21",
		});
		meshObj = tree.group;
		cleanup = () => tree.dispose();
	}

	if (!meshObj) return catalog.preview;

	generatorScene!.add(meshObj);

	// Center and frame the object
	const box = new THREE.Box3().setFromObject(meshObj);
	const center = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());
	
	const maxDim = Math.max(size.x, size.y, size.z);
	const fov = generatorCamera!.fov * (Math.PI / 180);
	let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
	cameraZ *= 1.3; // Zoom out a bit

	generatorCamera!.position.set(center.x + cameraZ * 0.6, center.y + cameraZ * 0.4, center.z + cameraZ);
	generatorCamera!.lookAt(center);

	generatorRenderer!.render(generatorScene!, generatorCamera!);
	const dataUrl = generatorRenderer!.domElement.toDataURL("image/png");

	generatorScene!.remove(meshObj);
	if (cleanup) cleanup();

	thumbnailCache.set(meshId, dataUrl);
	return dataUrl;
}
