import * as THREE from "three";

export function createFpvInterior(): THREE.Group {
	const interior = new THREE.Group();
	interior.name = "fpv-interior";

	const dashMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, metalness: 0.1 });
	const woodMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.4, metalness: 0.1 });
	const metalMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.5, metalness: 0.8 });
	const gloveMat = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, roughness: 0.7 });
	const roofMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
	const mirrorMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 0.1, metalness: 0.9 });

	// Dashboard - Made thinner and lower to reveal the hood
	const dashGeo = new THREE.BoxGeometry(1.6, 0.15, 0.4);
	const dashboard = new THREE.Mesh(dashGeo, dashMat);
	dashboard.position.set(0, 0.35, 0.1); 
	dashboard.castShadow = true;
	dashboard.receiveShadow = true;
	interior.add(dashboard);

	// Speedometer cluster
	const speedoGeo = new THREE.BoxGeometry(0.4, 0.1, 0.15);
	const speedo = new THREE.Mesh(speedoGeo, dashMat);
	speedo.position.set(-0.35, 0.42, 0.05);
	interior.add(speedo);
	
	// Center console
	const consoleGeo = new THREE.BoxGeometry(0.25, 0.25, 0.8);
	const centerConsole = new THREE.Mesh(consoleGeo, dashMat);
	centerConsole.position.set(0, 0.2, -0.2);
	interior.add(centerConsole);

	// Steering Column
	const columnGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.3);
	const column = new THREE.Mesh(columnGeo, dashMat);
	column.rotation.x = Math.PI / 2 + 0.25; 
	column.position.set(-0.35, 0.38, -0.05);
	interior.add(column);

	// Steering Wheel Group (so we can rotate it and hands together)
	const steeringWheel = new THREE.Group();
	steeringWheel.position.set(-0.35, 0.48, -0.15);
	steeringWheel.rotation.x = -0.25; 
	steeringWheel.name = "steering-wheel";

	// Wheel Rim (Wood)
	const rimGeo = new THREE.TorusGeometry(0.16, 0.015, 16, 32);
	const rim = new THREE.Mesh(rimGeo, woodMat);
	steeringWheel.add(rim);

	// Center Cap & Spokes
	const capGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.02);
	const cap = new THREE.Mesh(capGeo, metalMat);
	cap.rotation.x = Math.PI / 2;
	steeringWheel.add(cap);

	const spokeGeo = new THREE.BoxGeometry(0.015, 0.16, 0.01);
	const leftSpoke = new THREE.Mesh(spokeGeo, metalMat);
	leftSpoke.position.set(-0.08, 0, 0);
	leftSpoke.rotation.z = Math.PI / 2;
	steeringWheel.add(leftSpoke);

	const rightSpoke = new THREE.Mesh(spokeGeo, metalMat);
	rightSpoke.position.set(0.08, 0, 0);
	rightSpoke.rotation.z = Math.PI / 2;
	steeringWheel.add(rightSpoke);
	
	const bottomSpoke = new THREE.Mesh(spokeGeo, metalMat);
	bottomSpoke.position.set(0, -0.08, 0);
	steeringWheel.add(bottomSpoke);

	// Driver's Hands (White Gloves)
	const handGeo = new THREE.CapsuleGeometry(0.025, 0.06, 4, 8);
	
	const leftHand = new THREE.Mesh(handGeo, gloveMat);
	leftHand.position.set(-0.14, 0.05, 0.02);
	leftHand.rotation.z = -0.3;
	leftHand.rotation.x = 0.5;
	steeringWheel.add(leftHand);

	const rightHand = new THREE.Mesh(handGeo, gloveMat);
	rightHand.position.set(0.14, 0.05, 0.02);
	rightHand.rotation.z = 0.3;
	rightHand.rotation.x = 0.5;
	steeringWheel.add(rightHand);

	interior.add(steeringWheel);

	// A-Pillars (angled perfectly for the windshield)
	const pillarGeo = new THREE.BoxGeometry(0.06, 0.8, 0.08); 
	
	const leftPillar = new THREE.Mesh(pillarGeo, roofMat);
	leftPillar.position.set(-0.75, 0.8, 0.2); 
	leftPillar.rotation.z = -0.2;
	leftPillar.rotation.x = -0.5;
	interior.add(leftPillar);

	const rightPillar = new THREE.Mesh(pillarGeo, roofMat);
	rightPillar.position.set(0.75, 0.8, 0.2);
	rightPillar.rotation.z = 0.2;
	rightPillar.rotation.x = -0.5;
	interior.add(rightPillar);

	// Roof & Sun Visors
	const roofGeo = new THREE.BoxGeometry(1.6, 0.05, 1.2);
	const roof = new THREE.Mesh(roofGeo, roofMat);
	roof.position.set(0, 1.3, -0.2);
	interior.add(roof);

	const visorGeo = new THREE.BoxGeometry(0.35, 0.02, 0.15);
	const leftVisor = new THREE.Mesh(visorGeo, roofMat);
	leftVisor.position.set(-0.35, 1.25, 0.25);
	leftVisor.rotation.x = 0.2;
	interior.add(leftVisor);

	const rightVisor = new THREE.Mesh(visorGeo, roofMat);
	rightVisor.position.set(0.35, 1.25, 0.25);
	rightVisor.rotation.x = 0.2;
	interior.add(rightVisor);

	// Rearview Mirror
	const mirrorCasingGeo = new THREE.BoxGeometry(0.2, 0.06, 0.04);
	const mirrorCasing = new THREE.Mesh(mirrorCasingGeo, roofMat);
	mirrorCasing.position.set(0, 1.15, 0.3);
	mirrorCasing.rotation.x = -0.1;
	
	const mirrorGlassGeo = new THREE.BoxGeometry(0.19, 0.05, 0.01);
	const mirrorGlass = new THREE.Mesh(mirrorGlassGeo, mirrorMat);
	mirrorGlass.position.set(0, 0, -0.02); // Front of casing
	mirrorCasing.add(mirrorGlass);
	
	const mirrorArmGeo = new THREE.CylinderGeometry(0.01, 0.01, 0.1);
	const mirrorArm = new THREE.Mesh(mirrorArmGeo, roofMat);
	mirrorArm.position.set(0, 0.05, 0.02);
	mirrorArm.rotation.x = -0.5;
	mirrorCasing.add(mirrorArm);

	interior.add(mirrorCasing);

	return interior;
}
