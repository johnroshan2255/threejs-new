import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

interface BridgeChunkDef {
    zMin: number;
    zMax: number;
    items: {
        isGutter: boolean;
        pos: THREE.Vector3;
        quat: THREE.Quaternion;
        width: number;
        height: number;
        length: number;
    }[];
    isInstantiated: boolean;
    meshes: THREE.Mesh[];
    bodies: RAPIER.RigidBody[];
    colliders: RAPIER.Collider[];
}

export class ProceduralBridge {
    public group: THREE.Group;
    private material: THREE.MeshStandardMaterial;
    private geometry = new THREE.BoxGeometry(1, 1, 1);
    
    // Path generation state
    private points: THREE.Vector3[] = [];
    private currentPos: THREE.Vector3;
    private currentAngle: number = 0;
    private previousTurn: number = 0;
    
    // Chunk streaming state
    private chunks: BridgeChunkDef[] = [];
    private lastGeneratedZ: number;
    private loadDistance: number = 200; // Load 200m around the car
    
    // Bridge settings
    private segmentWidth: number;
    private thickness: number;
    private stepSize: number = 1.5;
    private maxZ: number;

    constructor(
        private world: RAPIER.World,
        startPos: THREE.Vector3,
        segmentWidth: number = 8,
        thickness: number = 2,
        maxZ: number = Infinity
    ) {
        this.group = new THREE.Group();
        this.group.position.copy(startPos);
        this.segmentWidth = segmentWidth;
        this.thickness = thickness;
        this.maxZ = maxZ;

        const loader = new THREE.TextureLoader();
        const basePath = "/stone_bricks_wall_07_1k/stone_bricks_wall_07_";
        
        const map = loader.load(`${basePath}baseColor_1k.png`);
        const normalMap = loader.load(`${basePath}normal_gl_1k.png`);
        const roughnessMap = loader.load(`${basePath}roughness_1k.png`);
        const aoMap = loader.load(`${basePath}ambientOcclusion_1k.png`);

        [map, normalMap, roughnessMap, aoMap].forEach(tex => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
        });

        this.material = new THREE.MeshStandardMaterial({
            map, normalMap, roughnessMap, aoMap,
            roughness: 0.9, metalness: 0.0
        });

        // Initialize path
        this.currentPos = new THREE.Vector3(0, 0, 0);
        this.points.push(this.currentPos.clone());
        this.currentPos.z += 8; // First 8m straight
        this.points.push(this.currentPos.clone());
        this.lastGeneratedZ = this.group.position.z + 8;

        // Generate initial chunks
        this.generateNextSegment();
    }

    private generateNextSegment() {
        const segmentStep = 20;

        // Generate next path point
        const choices = [-Math.PI / 4, Math.PI / 4, 0];
        let turn = choices[Math.floor(Math.random() * choices.length)];
        
        if (this.previousTurn === 0) {
            turn = Math.random() > 0.5 ? Math.PI / 4 : -Math.PI / 4;
        }

        this.previousTurn = turn;
        this.currentAngle += turn;
        this.currentAngle = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, this.currentAngle));

        const direction = new THREE.Vector3(Math.sin(this.currentAngle), 0, Math.cos(this.currentAngle));
        this.currentPos.add(direction.clone().multiplyScalar(segmentStep));
        this.points.push(this.currentPos.clone());
        
        // We need at least 2 points to make a curve, but since we just pushed one, 
        // we can take the last 3 points to make a CatmullRomCurve3 for this segment
        const pCount = this.points.length;
        const curvePoints = [
            this.points[pCount - 3],
            this.points[pCount - 2],
            this.points[pCount - 1]
        ];
        
        const curve = new THREE.CatmullRomCurve3(curvePoints);
        
        // Build the visual and physics objects for this curve
        const numSteps = Math.floor(curve.getLength() / this.stepSize);
        const gutterWidth = 0.8;
        const gutterHeight = 1.0;
        
        const chunkDef: BridgeChunkDef = {
            zMin: this.group.position.z + curvePoints[0].z,
            zMax: this.group.position.z + curvePoints[2].z,
            items: [],
            isInstantiated: false,
            meshes: [],
            bodies: [],
            colliders: []
        };

        for (let i = 0; i < numSteps; i++) {
            // We only build the second half of the curve to avoid overlap with previous segment
            // because curvePoints overlaps with the previous curve generation
            if (i < numSteps / 2 && pCount > 3) continue;

            const t1 = i / numSteps;
            const t2 = (i + 1) / numSteps;
            
            const p1 = curve.getPointAt(t1);
            const p2 = curve.getPointAt(t2);
            const center = new THREE.Vector3().addVectors(p1, p2).multiplyScalar(0.5);
            
            const tangent = curve.getTangentAt(t1).normalize();
            const up = new THREE.Vector3(0, 1, 0);
            const right = new THREE.Vector3().crossVectors(tangent, up).normalize();
            
            const rotationMatrix = new THREE.Matrix4().lookAt(new THREE.Vector3(0,0,0), tangent, up);
            const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);

            const actualLength = p1.distanceTo(p2) + 0.1;
            
            const tiltX = (Math.random() - 0.5) * 0.05;
            const tiltZ = (Math.random() - 0.5) * 0.05;
            const dropY = -Math.random() * 0.2;
            
            const floorCenter = center.clone();
            floorCenter.y += dropY;
            const floorQuat = quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, 0, tiltZ)));
            
            // Store floor definition
            chunkDef.items.push({
                isGutter: false,
                pos: floorCenter,
                quat: floorQuat,
                width: this.segmentWidth,
                height: this.thickness,
                length: actualLength
            });

            // Left Gutter
            if (Math.random() > 0.15) { 
                const leftPos = center.clone().add(right.clone().multiplyScalar(this.segmentWidth / 2 - gutterWidth / 2));
                leftPos.y += this.thickness / 2 + gutterHeight / 2 + dropY;
                const tiltX = (Math.random() - 0.5) * 0.1;
                const tiltZ = (Math.random() - 0.5) * 0.1;
                const gutterQuat = quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, 0, tiltZ)));
                chunkDef.items.push({
                    isGutter: true, pos: leftPos, quat: gutterQuat, 
                    width: gutterWidth, height: gutterHeight, length: actualLength
                });
            }

            // Right Gutter
            if (Math.random() > 0.15) { 
                const rightPos = center.clone().add(right.clone().multiplyScalar(-this.segmentWidth / 2 + gutterWidth / 2));
                rightPos.y += this.thickness / 2 + gutterHeight / 2 + dropY;
                const tiltX = (Math.random() - 0.5) * 0.1;
                const tiltZ = (Math.random() - 0.5) * 0.1;
                const gutterQuat = quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, 0, tiltZ)));
                chunkDef.items.push({
                    isGutter: true, pos: rightPos, quat: gutterQuat, 
                    width: gutterWidth, height: gutterHeight, length: actualLength
                });
            }
        }

        this.chunks.push(chunkDef);
        this.lastGeneratedZ = chunkDef.zMax;
    }

    public update(carPosition: THREE.Vector3) {
        // 1. Generate new chunk definitions if we are getting close to the frontier
        // Stop generating once we hit the maxZ cap
        if (carPosition.z + this.loadDistance > this.lastGeneratedZ && this.lastGeneratedZ < this.maxZ) {
            this.generateNextSegment();
        }

        // 2. Bidirectional Streaming: Instantiate or Destroy chunks based on distance
        for (const chunk of this.chunks) {
            const distance = Math.min(Math.abs(chunk.zMin - carPosition.z), Math.abs(chunk.zMax - carPosition.z));
            
            if (distance < this.loadDistance && !chunk.isInstantiated) {
                // Every bridge piece uses the same box geometry and material, so a
                // whole streamed chunk can be rendered in one draw call.
                const mesh = new THREE.InstancedMesh(
                    this.geometry,
                    this.material,
                    chunk.items.length
                );
                const dummy = new THREE.Object3D();
                mesh.name = "ProceduralBridgeChunk";
                mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
                mesh.castShadow = true;
                mesh.receiveShadow = true;

                for (let i = 0; i < chunk.items.length; i++) {
                    const item = chunk.items[i];
                    dummy.position.copy(item.pos);
                    dummy.quaternion.copy(item.quat);
                    dummy.scale.set(item.width, item.height, item.length);
                    dummy.updateMatrix();
                    mesh.setMatrixAt(i, dummy.matrix);

                    const worldPos = item.pos.clone().add(this.group.position);
                    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(worldPos.x, worldPos.y, worldPos.z);
                    const body = this.world.createRigidBody(bodyDesc);
                    body.setRotation(item.quat, true);
                    const colDesc = RAPIER.ColliderDesc.cuboid(item.width / 2, item.height / 2, item.length / 2);
                    const col = this.world.createCollider(colDesc, body);
                    chunk.bodies.push(body);
                    chunk.colliders.push(col);
                }

                mesh.instanceMatrix.needsUpdate = true;
                mesh.computeBoundingBox();
                mesh.computeBoundingSphere();
                this.group.add(mesh);
                chunk.meshes.push(mesh);
                chunk.isInstantiated = true;
            } else if (distance > this.loadDistance + 50 && chunk.isInstantiated) {
                // Destroy (cull)
                for (const mesh of chunk.meshes) {
                    this.group.remove(mesh);
                }
                chunk.meshes = [];
                for (const body of chunk.bodies) {
                    this.world.removeRigidBody(body);
                }
                chunk.bodies = [];
                chunk.colliders = [];
                chunk.isInstantiated = false;
            }
        }
    }

    public dispose() {
        for (const chunk of this.chunks) {
            for (const mesh of chunk.meshes) {
                this.group.remove(mesh);
            }
            for (const body of chunk.bodies) {
                this.world.removeRigidBody(body);
            }
        }
        this.chunks = [];
        for (const texture of [
            this.material.map,
            this.material.normalMap,
            this.material.roughnessMap,
            this.material.aoMap
        ]) {
            texture?.dispose();
        }
        this.geometry.dispose();
        this.material.dispose();
        this.group.removeFromParent();
    }

    public getLastGeneratedZ(): number {
        return this.lastGeneratedZ;
    }

    public getLastGeneratedX(): number {
        if (this.points.length === 0) return this.group.position.x;
        return this.group.position.x + this.points[this.points.length - 1].x;
    }

    public getFinalHeight(): number {
        if (this.chunks.length === 0) return this.group.position.y + this.thickness / 2;
        const lastChunk = this.chunks[this.chunks.length - 1];
        if (lastChunk.items.length === 0) return this.group.position.y + this.thickness / 2;
        
        // Find a floor item (isGutter = false)
        for (const item of lastChunk.items) {
            if (!item.isGutter) {
                return item.pos.y + this.group.position.y + item.height / 2;
            }
        }
        return lastChunk.items[0].pos.y + this.group.position.y + lastChunk.items[0].height / 2;
    }
}
