import * as THREE from "three";
import type { HumanEntity } from "./HumanEntity";
import { type MobileControls } from "../../ui/mobileControls";

export class HumanInput {
    public isEnabled = false;
    private human: HumanEntity;
    private keys: { [key: string]: boolean } = {};
    private walkSpeed = 2.0;
    private runSpeed = 6.0;
    private jumpForce = 8.0;
    private rotationSmoothness = 10.0;
    
    private lastJumpTime = 0;
    
    // Procedural Pickup
    private isPickingUp = false;
    private pickupTimer = 0;
    private pickupDuration = 1.0;
    private targetPickupObject: THREE.Object3D | null = null;
    public checkCanPickup: (() => THREE.Object3D | null) | null = null;
    public checkIsHoldingObject: (() => THREE.Object3D | null) | null = null;
    public onGrabObject: ((obj: THREE.Object3D) => void) | null = null;
    public onThrowObject: ((obj: THREE.Object3D) => void) | null = null;
    
    private isThrowing = false;
    private throwTimer = 0;
    private throwDuration = 1.0;
    
    // For mobile
    private mobileControls: MobileControls | null = null;
    
    // Vectors for calculation
    private moveDir = new THREE.Vector3();
    private cameraFwd = new THREE.Vector3();
    private cameraRight = new THREE.Vector3();
    private targetRotation = new THREE.Quaternion();

    constructor(human: HumanEntity) {
        this.human = human;

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("contextmenu", this.onRightClick);
    }

    public dispose() {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("contextmenu", this.onRightClick);
    }

    public setMobileControls(mc: MobileControls) {
        this.mobileControls = mc;
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.isEnabled || !e.key) return;
        const k = e.key.toLowerCase();
        this.keys[k] = true;
        if (k === "t") this.triggerPickup();
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (!e.key) return;
        this.keys[e.key.toLowerCase()] = false;
    };

    private onRightClick = (e: MouseEvent) => {
        if (!this.isEnabled) return;
        e.preventDefault();
        this.triggerPickup();
    };

    public triggerPickup() {
        const currentVel = this.human.body.linvel();
        
        // If holding an object, throw it instead!
        if (this.checkIsHoldingObject) {
            const heldObj = this.checkIsHoldingObject();
            if (heldObj) {
                if (!this.isThrowing) {
                    this.isThrowing = true;
                    this.throwTimer = 0;
                    this.targetPickupObject = heldObj;
                    this.human.playAnimation("idle");
                    this.human.body.setLinvel({x: 0, y: currentVel.y, z: 0}, true);
                }
                return; // don't pick up
            }
        }

        if (this.checkCanPickup) {
            const obj = this.checkCanPickup();
            if (!obj) return; // Not near any object
            this.targetPickupObject = obj;
        }

        if (!this.isPickingUp && this.targetPickupObject) {
            this.isPickingUp = true;
            this.pickupTimer = 0;
            this.human.playAnimation("idle");
            // Stop horizontal movement instantly
            this.human.body.setLinvel({x: 0, y: currentVel.y, z: 0}, true);
        }
    }

    public update(dt: number, camera: THREE.PerspectiveCamera) {
        let forward = 0;
        let right = 0;
        
        if (this.isEnabled) {
            if (this.keys["w"] || this.keys["arrowup"]) forward += 1;
            if (this.keys["s"] || this.keys["arrowdown"]) forward -= 1;
            if (this.keys["a"] || this.keys["arrowleft"]) right -= 1;
            if (this.keys["d"] || this.keys["arrowright"]) right += 1;

            if (this.mobileControls) {
                const state = this.mobileControls.getState();
                forward += state.throttle; // Throttle is 0 to 1
                if (state.braking) forward -= 1; // Brake/Reverse
                right += state.steer;      // Steer is -1 to 1
            }
        }

        const isRunning = this.keys["shift"];
        const currentSpeed = isRunning ? this.runSpeed : this.walkSpeed;

        // Jump Logic
        const currentVel = this.human.body.linvel();
        const now = performance.now();
        // Simple grounded check using Y velocity and a cooldown
        const isGrounded = Math.abs(currentVel.y) < 0.1;
        if (this.isEnabled && this.keys[" "] && isGrounded && now - this.lastJumpTime > 500) {
            currentVel.y = this.jumpForce;
            this.lastJumpTime = now;
        }

        // Pickup Logic
        if (this.isPickingUp) {
            const previousTimer = this.pickupTimer;
            this.pickupTimer += dt;
            const progress = this.pickupTimer / this.pickupDuration;
            
            // Pass progress to HumanEntity for procedural bone bending
            this.human.pickupProgress = progress;

            // Grab object right at the halfway point (when fully bent over)
            if (previousTimer < 0.5 * this.pickupDuration && this.pickupTimer >= 0.5 * this.pickupDuration) {
                if (this.onGrabObject && this.targetPickupObject) {
                    this.onGrabObject(this.targetPickupObject);
                }
            }

            if (progress >= 1.0) {
                this.isPickingUp = false;
                this.human.pickupProgress = 0;
                this.targetPickupObject = null;
            } else {
                // If picking up, do not allow movement
                return;
            }
        } else if (this.isThrowing) {
            const previousTimer = this.throwTimer;
            this.throwTimer += dt;
            const progress = this.throwTimer / this.throwDuration;
            
            this.human.throwProgress = progress;

            // Throw exactly halfway through
            if (previousTimer < 0.5 * this.throwDuration && this.throwTimer >= 0.5 * this.throwDuration) {
                if (this.onThrowObject && this.targetPickupObject) {
                    this.onThrowObject(this.targetPickupObject);
                }
            }

            if (progress >= 1.0) {
                this.isThrowing = false;
                this.human.throwProgress = 0;
                this.targetPickupObject = null;
            } else {
                return;
            }
        }

        // Clamp to unit vector
        if (forward !== 0 || right !== 0) {
            const length = Math.sqrt(forward * forward + right * right);
            forward /= length;
            right /= length;
        }

        // Get camera basis vectors
        camera.getWorldDirection(this.cameraFwd);
        this.cameraFwd.y = 0;
        this.cameraFwd.normalize();
        
        this.cameraRight.crossVectors(this.cameraFwd, new THREE.Vector3(0, 1, 0)).normalize();

        // Calculate world movement direction
        this.moveDir.set(0, 0, 0);
        this.moveDir.addScaledVector(this.cameraFwd, forward);
        this.moveDir.addScaledVector(this.cameraRight, right);

        if (this.moveDir.lengthSq() > 0.01) {
            this.moveDir.normalize();
            
            // Set horizontal velocity, preserve vertical (gravity or jump)
            this.human.body.setLinvel({
                x: this.moveDir.x * currentSpeed,
                y: currentVel.y,
                z: this.moveDir.z * currentSpeed
            }, true);

            // Rotate visual mesh to face movement direction
            const angle = Math.atan2(this.moveDir.x, this.moveDir.z);
            this.targetRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
            
            // Smoothly interpolate current rotation to target rotation
            this.human.mesh.quaternion.slerp(this.targetRotation, dt * this.rotationSmoothness);

            if (isGrounded) {
                this.human.playAnimation(isRunning ? "run" : "walk");
            }
        } else {
            // Apply preserved vertical velocity even when not moving horizontally
            this.human.body.setLinvel({
                x: 0,
                y: currentVel.y,
                z: 0
            }, true);
            
            if (isGrounded) {
                this.human.playAnimation("idle");
            }
        }
        
        // Attempt to play a jump animation if airborne
        if (!isGrounded) {
            this.human.playAnimation("jump");
        }
    }
}
