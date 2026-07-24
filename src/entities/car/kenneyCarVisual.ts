import * as THREE from "three";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { CAR_CONFIG } from "./carConfig";

const MODEL_BASE = "/models/kenney/";
const COLORMAP_URL = `${MODEL_BASE}Textures/colormap.png`;

/** Matches Rapier wheel index order in createCar. */
const WHEEL_GROUP_NAMES = [
	"wheel-back-left",
	"wheel-back-right",
	"wheel-front-left",
	"wheel-front-right",
] as const;

const WHEEL_XZ_SPREAD = 1.04;
const WHEEL_PHYSICS_Y_DROP = 0.16;

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

export type KenneyCarLayout = {
	body: THREE.Group;
	wheelTemplate: THREE.Group;
	physicsWheelPositions: [number, number, number][];
	wheelRadius: number;
	chassisSize: { x: number; y: number; z: number };
};

let colormapPromise: Promise<THREE.Texture> | null = null;

function loadColormap(manager?: THREE.LoadingManager): Promise<THREE.Texture> {
	if (!colormapPromise) {
		colormapPromise = new Promise((resolve, reject) => {
			new THREE.TextureLoader(manager).load(
				COLORMAP_URL,
				(tex) => {
					tex.colorSpace = THREE.SRGBColorSpace;
					tex.magFilter = THREE.NearestFilter;
					tex.minFilter = THREE.LinearMipmapLinearFilter;
					resolve(tex);
				},
				undefined,
				reject
			);
		});
	}
	return colormapPromise;
}

function applyColormapMaterials(root: THREE.Object3D, colormap: THREE.Texture) {
	root.traverse((child) => {
		if (!(child instanceof THREE.Mesh)) return;
		child.castShadow = true;
		child.receiveShadow = true;

		const mats = Array.isArray(child.material) ? child.material : [child.material];
		const next = mats.map(
			() =>
				new THREE.MeshStandardMaterial({
					map: colormap,
					roughness: 0.72,
					metalness: 0.06,
				})
		);
		child.material = next.length === 1 ? next[0] : next;
	});
}

function loadObjWithMtl(
	objPath: string,
	mtlPath: string,
	manager?: THREE.LoadingManager
): Promise<THREE.Group> {
	const mtlLoader = new MTLLoader(manager);
	mtlLoader.setResourcePath(MODEL_BASE);

	return new Promise((resolve, reject) => {
		mtlLoader.load(
			mtlPath,
			(materials) => {
				materials.preload();
				const objLoader = new OBJLoader(manager);
				objLoader.setMaterials(materials);
				objLoader.load(objPath, resolve, undefined, reject);
			},
			undefined,
			reject
		);
	});
}

function hideBuiltInWheels(root: THREE.Object3D) {
	root.traverse((child) => {
		if (child.name.toLowerCase().includes("wheel")) {
			child.visible = false;
		}
	});
}

function findNamedChild(root: THREE.Object3D, name: string): THREE.Object3D | null {
	let found: THREE.Object3D | null = null;
	root.traverse((child) => {
		if (child.name === name) found = child;
	});
	return found;
}

function expandBodyBox(root: THREE.Object3D) {
	_box.makeEmpty();
	root.traverse((child) => {
		if (child instanceof THREE.Mesh && !child.name.toLowerCase().includes("wheel")) {
			_box.expandByObject(child);
		}
	});
	return !_box.isEmpty();
}

function getObjectCenter(target: THREE.Object3D): THREE.Vector3 {
	_box.setFromObject(target);
	_box.getCenter(_center);
	return _center.clone();
}

function getTireRadius(target: THREE.Object3D): number {
	_box.setFromObject(target);
	_box.getSize(_size);
	const radial = Math.max(_size.y, _size.z) * 0.5;
	return Math.max(radial, 0.16);
}

function layoutKenneySuv(
	suv: THREE.Group,
	colliderYOffset: number,
	scale: number
): KenneyCarLayout {
	suv.scale.setScalar(scale);
	suv.updateMatrixWorld(true);

	if (!expandBodyBox(suv)) {
		throw new Error("Kenney SUV body mesh not found");
	}

	_box.getCenter(_center);
	_box.getSize(_size);

	const hy = _size.y / 2;
	const chassisBottom = colliderYOffset - hy;

	suv.position.x = -_center.x;
	suv.position.z = -_center.z;
	suv.position.y = chassisBottom - _box.min.y;

	suv.updateMatrixWorld(true);

	const physicsWheelPositions = WHEEL_GROUP_NAMES.map((name) => {
		const wheelGroup = findNamedChild(suv, name);
		if (!wheelGroup) {
			throw new Error(`Missing Kenney wheel group: ${name}`);
		}
		const c = getObjectCenter(wheelGroup);
		return [
			c.x * WHEEL_XZ_SPREAD,
			c.y - WHEEL_PHYSICS_Y_DROP,
			c.z * WHEEL_XZ_SPREAD,
		] as [number, number, number];
	});

	expandBodyBox(suv);
	_box.getSize(_size);

	const body = new THREE.Group();
	body.name = "kenney-suv-body";
	body.add(suv);
	body.renderOrder = 5;

	return {
		body,
		wheelTemplate: null as unknown as THREE.Group,
		physicsWheelPositions,
		wheelRadius: 0.18,
		chassisSize: { x: _size.x, y: _size.y, z: _size.z },
	};
}

function prepareWheelTemplate(template: THREE.Group, targetRadius: number): THREE.Group {
	const wheel = template.clone(true);

	const radius = getTireRadius(wheel);
	const scale = targetRadius / Math.max(radius, 0.001);
	wheel.scale.setScalar(scale);

	const c = getObjectCenter(wheel);
	wheel.position.sub(c);

	return wheel;
}

export async function loadKenneySuvVisual(
	colliderYOffset: number,
	manager?: THREE.LoadingManager
): Promise<KenneyCarLayout> {
	const colormap = await loadColormap(manager);

	const [suv, wheelObj] = await Promise.all([
		loadObjWithMtl(`${MODEL_BASE}suv.obj`, `${MODEL_BASE}suv.mtl`, manager),
		loadObjWithMtl(
			`${MODEL_BASE}wheel-default.obj`,
			`${MODEL_BASE}wheel-default.mtl`,
			manager
		),
	]);

	applyColormapMaterials(suv, colormap);
	applyColormapMaterials(wheelObj, colormap);
	hideBuiltInWheels(suv);

	const scale = CAR_CONFIG.scale;
	const layout = layoutKenneySuv(suv, colliderYOffset, scale);

	const tireRadius = getTireRadius(wheelObj) * scale;
	layout.wheelRadius = Math.max(tireRadius, 0.18 * scale);

	layout.wheelTemplate = prepareWheelTemplate(wheelObj, layout.wheelRadius);
	layout.wheelTemplate.renderOrder = 5;

	return layout;
}
