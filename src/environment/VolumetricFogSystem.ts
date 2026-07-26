import * as THREE from 'three';

export class VolumetricFogSystem {
    public group: THREE.Group;
    private mesh: THREE.InstancedMesh;
    private dummy: THREE.Object3D;
    private particleCount: number;

    constructor(count: number = 600) {
        this.group = new THREE.Group();
        this.particleCount = count;
        this.dummy = new THREE.Object3D();

        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0)';
        ctx.fillRect(0, 0, 128, 128);

        // Draw overlapping soft circles for a fluffier cloud shape
        const drawSoftCircle = (x: number, y: number, r: number, opacity: number) => {
            const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
            gradient.addColorStop(0, `rgba(220, 230, 240, ${opacity})`);
            gradient.addColorStop(0.5, `rgba(220, 230, 240, ${opacity * 0.4})`);
            gradient.addColorStop(1, 'rgba(220, 230, 240, 0)');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        };

        drawSoftCircle(64, 64, 60, 0.4);
        drawSoftCircle(40, 70, 40, 0.2);
        drawSoftCircle(88, 70, 40, 0.2);
        drawSoftCircle(64, 40, 40, 0.2);

        const texture = new THREE.CanvasTexture(canvas);

        const geo = new THREE.PlaneGeometry(1, 1);
        const mat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            opacity: 0.8,
            color: 0xffffff,
            blending: THREE.NormalBlending,
        });

        this.mesh = new THREE.InstancedMesh(geo, mat, count);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;

        this.group.add(this.mesh);
        
        for (let i = 0; i < count; i++) {
            this.mesh.setMatrixAt(i, new THREE.Matrix4());
        }
    }

    public update(carPos: THREE.Vector3, camera: THREE.Camera) {
        const time = performance.now() * 0.0005;

        for (let i = 0; i < this.particleCount; i++) {
            const rand1 = Math.sin(i * 123.456);
            const rand2 = Math.cos(i * 789.123);
            const rand3 = Math.sin(i * 456.789);
            const rand4 = Math.cos(i * 159.357);

            // Create a hollow ring of fog.
            // Island is roughly up to 60m radius.
            // Fog starts at 65m and goes out to 300m.
            const minRadius = 65;
            const maxRadius = 300;
            const r = minRadius + (maxRadius - minRadius) * Math.abs(rand1);
            
            const theta = rand2 * Math.PI * 2;
            
            let x = r * Math.cos(theta);
            let z = r * Math.sin(theta);
            
            // If the car goes deep into the bridge (e.g. Z > 100), shift the fog forward
            // so we don't run out of fog, but keep the hollow area behind so we don't cover the grass.
            if (carPos.z > 100) {
                z += (carPos.z - 100);
            }

            // Height sits below the grass (which is at Y=0).
            const y = -14 + Math.abs(rand3) * 11; 

            // Localized drifting (bobbing and tiny circles) instead of global wind
            // This prevents them from moving across the grass.
            const localDriftX = Math.sin(time + i) * 3;
            const localDriftZ = Math.cos(time + i) * 3;
            const bobbingY = Math.sin(time * 2 + i) * 1.5;

            this.dummy.position.set(x + localDriftX, y + bobbingY, z + localDriftZ);
            
            // Wide, squashed scales to look like a flat cloud layer
            const scaleX = 45 + Math.abs(rand1) * 35;
            const scaleY = 15 + Math.abs(rand4) * 15;
            this.dummy.scale.set(scaleX, scaleY, scaleX);

            // Billboard: face camera
            this.dummy.quaternion.copy(camera.quaternion);

            this.dummy.updateMatrix();
            this.mesh.setMatrixAt(i, this.dummy.matrix);
        }
        
        this.mesh.instanceMatrix.needsUpdate = true;
    }
}
