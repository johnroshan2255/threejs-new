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
            const nameLower = clip.name.toLowerCase();
            
            // Strip horizontal root motion for locomotion animations so they play in-place
            if (nameLower.includes("walk") || nameLower.includes("run")) {
                clip.tracks.forEach(track => {
                    if (track.name.toLowerCase().includes(".position")) {
                        const values = track.values;
                        const startX = values[0];
                        const startZ = values[2];
                        for (let i = 0; i < values.length; i += 3) {
                            values[i] = startX;
                            values[i + 2] = startZ;
                        }
                    }
                });
            }

            const action = this.mixer.clipAction(clip);
            this.animations.set(nameLower, action);
        });

        // Physics Setup (Capsule)
        const radius = 0.45; // reduced so players can get closer
        const halfHeight = 1.5; // scaled by 3
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

        // Sync visual mesh to physics body
        const translation = this.body.translation();
        // Offset mesh down so feet are at bottom of capsule.
        this.mesh.position.set(translation.x, translation.y - 2.4, translation.z); 
    }



    public playAnimation(name: string, fadeDuration: number = 0.2): number {
        const lowerName = name.toLowerCase();
        let targetAction: THREE.AnimationAction | undefined;
        
        // Exact match first
        for (const [clipName, action] of this.animations.entries()) {
            if (clipName === lowerName) {
                targetAction = action;
                break;
            }
        }

        // Partial match fallback
        if (!targetAction) {
            for (const [clipName, action] of this.animations.entries()) {
                if (clipName.includes(lowerName)) {
                    targetAction = action;
                    break;
                }
            }
        }

        if (!targetAction) return 0;

        if (targetAction !== this.activeAction) {
            if (this.activeAction) {
                this.activeAction.fadeOut(fadeDuration);
            }

            targetAction.reset().fadeIn(fadeDuration);
            
            if (lowerName === "being carried" || lowerName === "fall down" || lowerName === "sit to stand" || lowerName === "sweep fall" || lowerName === "stand to sit") {
                targetAction.setLoop(THREE.LoopOnce, 1);
                targetAction.clampWhenFinished = true;
            } else {
                targetAction.setLoop(THREE.LoopRepeat, Infinity);
                targetAction.clampWhenFinished = false;
            }
            
            targetAction.play();
            this.activeAction = targetAction;
            this.activeAnimationName = targetAction.getClip().name.toLowerCase();
        }

        return targetAction.getClip().duration;
    }
}
