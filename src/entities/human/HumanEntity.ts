import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

export class HumanEntity {
    public mesh: THREE.Group;
    public body: RAPIER.RigidBody;
    public collider: RAPIER.Collider;
    public mixer: THREE.AnimationMixer;
    public animations: Map<string, THREE.AnimationAction> = new Map();
    private activeAction: THREE.AnimationAction | null = null;
    public activeAnimationName: string | null = null;
    
    // Procedural Pickup State
    public pickupProgress: number = 0.0; // 0 to 1
    public throwProgress: number = 0.0; // 0 to 1
    private spineBone: THREE.Object3D | undefined;
    private rightArmBone: THREE.Object3D | undefined;
    private leftArmBone: THREE.Object3D | undefined;

    constructor(
        gltfScene: THREE.Group,
        gltfAnimations: THREE.AnimationClip[],
        world: RAPIER.World,
        initialPosition: THREE.Vector3
    ) {
        this.mesh = gltfScene;
        
        // Traverse to enable shadows
        this.mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        // Animations
        this.mixer = new THREE.AnimationMixer(this.mesh);
        console.log("[HumanEntity] Available animations:");
        gltfAnimations.forEach((clip) => {
            console.log(` - ${clip.name}`);
            const action = this.mixer.clipAction(clip);
            this.animations.set(clip.name.toLowerCase(), action);
        });

        // Physics Setup (Capsule)
        const radius = 0.3;
        const halfHeight = 0.5; // Total height = 1.0 + 2*0.3 = 1.6m
        const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(initialPosition.x, initialPosition.y + halfHeight + radius + 1.0, initialPosition.z)
            .setLinearDamping(4.0) // High damping to stop instantly when no input
            .setAngularDamping(1.0)
            .lockRotations(); // Keep character upright

        this.body = world.createRigidBody(rigidBodyDesc);

        const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
            .setFriction(0) // No friction so we don't stick to walls
            .setMass(70);

        this.collider = world.createCollider(colliderDesc, this.body);

        this.playAnimation("idle");
    }

    public update(dt: number) {
        this.mixer.update(dt);
        
        // Apply procedural overrides AFTER the mixer updates
        this.updateProceduralAnimation();

        // Sync visual mesh to physics body
        const translation = this.body.translation();
        // Offset mesh down so feet are at bottom of capsule.
        this.mesh.position.set(translation.x, translation.y - 0.8, translation.z); 
    }

    private updateProceduralAnimation() {
        if (this.pickupProgress <= 0) return;

        // Lazy initialize bones
        if (!this.spineBone) {
            this.mesh.traverse((child) => {
                const name = child.name.toLowerCase();
                if (name.includes("spine") && !this.spineBone) this.spineBone = child;
                if (name.includes("rightarm") && !this.rightArmBone) this.rightArmBone = child;
                if (name.includes("leftarm") && !this.leftArmBone) this.leftArmBone = child;
            });
        }

        if (this.throwProgress > 0) {
            // Throwing animation (2-handed overhead style)
            const p = this.throwProgress;
            
            // Windup from 0 to 0.5, then throw from 0.5 to 1.0
            const windup = p < 0.5 ? (p * 2) : 1 - ((p - 0.5) * 2);
            
            if (this.spineBone) {
                // Lean back during windup
                this.spineBone.rotateX(windup * 0.3);
            }
            
            // Bring arms forward, then lift them up/back during windup, and slam them down
            const armX = Math.PI / 4 + windup * Math.PI / 2;
            
            if (this.rightArmBone) {
                this.rightArmBone.rotateX(armX);
                this.rightArmBone.rotateZ(Math.PI / 6); // inward
            }
            if (this.leftArmBone) {
                this.leftArmBone.rotateX(armX);
                this.leftArmBone.rotateZ(-Math.PI / 6); // inward
            }
            return;
        }

        if (this.pickupProgress <= 0) return;

        // Calculate bend amount (0 to 1 to 0)
        // Progress goes from 0 to 1, so sin(progress * PI) creates a nice curve peaking at 0.5
        const bendAmount = Math.sin(this.pickupProgress * Math.PI);

        if (this.spineBone) {
            // Mixamo spine bones usually bend forward on the X axis
            this.spineBone.rotateX(Math.PI / 3 * bendAmount);
        }
        if (this.rightArmBone) {
            // Rotate arm down and forward
            this.rightArmBone.rotateZ(Math.PI / 4 * bendAmount);
            this.rightArmBone.rotateX(Math.PI / 4 * bendAmount);
        }
    }

    public playAnimation(name: string, fadeDuration: number = 0.2) {
        // Simple heuristic to match common animation names
        let targetAction: THREE.AnimationAction | undefined;
        
        // Find exact or partial match
        for (const [clipName, action] of this.animations.entries()) {
            if (clipName.includes(name.toLowerCase())) {
                targetAction = action;
                break;
            }
        }

        if (!targetAction || targetAction === this.activeAction) return;

        if (this.activeAction) {
            this.activeAction.fadeOut(fadeDuration);
        }

        targetAction.reset().fadeIn(fadeDuration).play();
        this.activeAction = targetAction;
        this.activeAnimationName = targetAction.getClip().name.toLowerCase();
    }
}
