import * as THREE from "three";
import {
	HumanEntity,
	hitReactionAnimName,
	type HitReaction,
} from "./HumanEntity";
import { type MobileControls } from "../../ui/mobileControls";
import {
	isGameKeyBlocked,
	isTextEntryTarget,
	isUiPointerTarget,
} from "../../ui/gameInputFocus";

export class HumanInput {
    public isEnabled = false;
    private human: HumanEntity;
    private keys: { [key: string]: boolean } = {};
    private walkSpeed = 2.0;
    private runSpeed = 6.0;
    private jumpForce = 8.0;
    private rotationSmoothness = 10.0;
    
    private lastJumpTime = 0;
    private jumpDuration = 0.8;
    
    // Procedural Pickup
    private isPickingUp = false;
    private pickupTimer = 0;
    private pickupDuration = 1.0;
    private targetPickupObject: THREE.Object3D | null = null;
    public checkCanPickup: (() => THREE.Object3D | null) | null = null;
    public checkIsHoldingObject: (() => THREE.Object3D | null) | null = null;
    public onGrabObject: ((obj: THREE.Object3D) => void) | null = null;
    public onThrowObject: ((obj: THREE.Object3D) => void) | null = null;
    
    // Player carrying
    public isCarryingPlayer = false;
    public checkCanPickupPlayer: (() => string | null) | null = null; // returns socketId
    public onGrabPlayer: ((socketId: string) => void) | null = null;
    public onThrowPlayer: ((socketId: string) => void) | null = null;
    public carriedPlayerId: string | null = null;

    /** Returns remote targets with approx head/spine world positions for punch tests. */
    public getPunchTargets:
        | (() => Array<{
              id: string;
              head: THREE.Vector3;
              spine: THREE.Vector3;
              feetY: number;
              position: THREE.Vector3;
              quaternion: THREE.Quaternion;
          }>)
        | null = null;
    public onPunchHit: ((targetId: string, reaction: HitReaction) => void) | null = null;
    /** Fired after root-motion is baked so multiplayer can snap-sync position. */
    public onHitRepositioned:
        | ((pos: THREE.Vector3, quat: THREE.Quaternion) => void)
        | null = null;
    
    private isThrowing = false;
    private throwTimer = 0;
    private throwDuration = 1.0;
    
    private knockbackTimer = 0;
    
    // Recovery sequence
    private recoveryState: "none" | "fall" | "sitToStand" | "sweepFall" | "standToSit" = "none";
    private recoveryTimer = 0;

    /** Stun while playing receive-hit anims so locomotion can't overwrite them. */
    private hitReactionTimer = 0;
    private hitReaction: HitReaction | null = null;
    private hitPhase: "none" | "react" | "getUp" = "none";
    private readonly hitStartHips = new THREE.Vector3();
    private hasHitStartHips = false;

    private rootMotionBufferFor(reaction: HitReaction | null): number {
        switch (reaction) {
            case "uppercut":
                return 1.0;
            case "sweep":
                return 1.5;
            case "side":
                return 1.2;
            default:
                return 1.0;
        }
    }
    
    // For mobile
    private mobileControls: MobileControls | null = null;
    
    // Vectors for calculation
    private moveDir = new THREE.Vector3();
    private cameraFwd = new THREE.Vector3();
    private cameraRight = new THREE.Vector3();
    private targetRotation = new THREE.Quaternion();
    private readonly upAxis = new THREE.Vector3(0, 1, 0);
    private readonly victimFwd = new THREE.Vector3();
    private readonly toAttacker = new THREE.Vector3();
    private isSwimming = false;

    private isLeftMouseDown = false;
    private isRightMouseDown = false;
    private leftMouseDownTime = 0;
    private attackTimer = 0;
    private attackDuration = 0;
    private readonly handPos = new THREE.Vector3();
    private readonly hitCooldowns = new Map<string, number>();
    private static readonly CONTACT_RADIUS = 0.65;
    private static readonly DROP_KICK_RADIUS = 1.35;
    private static readonly HIT_COOLDOWN_SEC = 0.5;
    /** Attacker in front of victim if facing-dot above this. */
    private static readonly FRONT_DOT = 0.25;

    constructor(human: HumanEntity) {
        this.human = human;

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("contextmenu", this.onRightClick);
        window.addEventListener("mousedown", this.onMouseDown);
        window.addEventListener("mouseup", this.onMouseUp);
    }

    public dispose() {
        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("contextmenu", this.onRightClick);
        window.removeEventListener("mousedown", this.onMouseDown);
        window.removeEventListener("mouseup", this.onMouseUp);
    }

    public setMobileControls(mc: MobileControls) {
        this.mobileControls = mc;
    }

    /** Drop every held key / button (form focus, leaving the game). */
    public releaseControls() {
        this.keys = {};
        this.isLeftMouseDown = false;
        this.isRightMouseDown = false;
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.isEnabled || !e.key) return;
        // Typing in a form (login, etc.) must never move or act.
        if (isGameKeyBlocked(e)) {
            this.releaseControls();
            return;
        }
        const k = e.key.toLowerCase();
        this.keys[k] = true;
        if (k === "t") this.triggerPickup();
        if (k === "h") this.triggerCarryPlayer();
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (!e.key) return;
        this.keys[e.key.toLowerCase()] = false;
    };

    private onRightClick = (e: MouseEvent) => {
        if (!this.isEnabled) return;
        // Keep the native menu over forms (paste into the login field).
        if (isUiPointerTarget(e.target) || isTextEntryTarget(e.target)) return;
        e.preventDefault();
    };

    private onMouseDown = (e: MouseEvent) => {
        if (!this.isEnabled) return;
        // Clicking a form / modal / nav button is UI, not a punch. Alt is the
        // cursor-mode modifier, so Alt+click is pointing, not fighting.
        if (isUiPointerTarget(e.target) || e.altKey) return;
        if (this.isCarryingPlayer) return; // Disable punches when carrying a player

        if (this.hitReactionTimer > 0) return;

        if (e.button === 0) { // left
            this.isLeftMouseDown = true;
            this.leftMouseDownTime = performance.now();
            const duration = this.human.playAnimation("punch one");
            this.attackTimer = duration;
            this.attackDuration = duration;
        } else if (e.button === 2) { // right
            this.isRightMouseDown = true;
            const duration = this.human.playAnimation("drop kick");
            this.attackTimer = duration;
            this.attackDuration = duration;
        }
    };

    private onMouseUp = (e: MouseEvent) => {
        if (!this.isEnabled) return;
        if (this.isCarryingPlayer) return;
        
        if (e.button === 0) {
            this.isLeftMouseDown = false;
        } else if (e.button === 2) {
            this.isRightMouseDown = false;
        }
    };

    public triggerPickup() {
        if (this.isCarryingPlayer) return; // Can't pick up bombs while carrying a player
        
        const currentVel = this.human.body.linvel();
        
        // If holding an object, throw it instead!
        if (this.checkIsHoldingObject) {
            const heldObj = this.checkIsHoldingObject();
            if (heldObj) {
                if (!this.isThrowing) {
                    this.isThrowing = true;
                    this.isPickingUp = false;
                    this.pickupTimer = 0;
                    this.throwTimer = 0;
                    this.targetPickupObject = heldObj;
                    const duration = this.human.playAnimation("throw");
                    this.throwDuration = duration > 0 ? duration : 1.0;
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
            const duration = this.human.playAnimation("lift");
            this.pickupDuration = duration > 0 ? duration : 1.0;
        }
    }

    public triggerCarryPlayer() {
        if (this.isCarryingPlayer) {
            // Drop/Throw the player
            this.isCarryingPlayer = false;
            if (this.onThrowPlayer && this.carriedPlayerId) {
                this.onThrowPlayer(this.carriedPlayerId);
            }
            this.carriedPlayerId = null;
            return;
        }

        if (this.checkCanPickupPlayer) {
            const playerId = this.checkCanPickupPlayer();
            if (playerId) {
                this.isCarryingPlayer = true;
                this.carriedPlayerId = playerId;
                if (this.onGrabPlayer) {
                    this.onGrabPlayer(playerId);
                }
            }
        }
    }

    public applyKnockback(impulse: THREE.Vector3) {
        this.human.body.applyImpulse(impulse, true);
        this.knockbackTimer = 0.5; // Stunned for 0.5 seconds while flying
        // Cancel pickup/throw if hit
        this.isPickingUp = false;
        this.isThrowing = false;
    }

    public startRecoverySequence(type: "fall" | "explosion" = "fall") {
        if (type === "explosion") {
            this.recoveryState = "sweepFall";
            const duration = this.human.playAnimation("sweep fall");
            this.recoveryTimer = duration > 0 ? duration : 2.0;
        } else {
            this.recoveryState = "fall";
            const duration = this.human.playAnimation("fall down");
            this.recoveryTimer = duration > 0 ? duration : 2.0;
        }
    }

    public isRecovering(): boolean {
        return this.recoveryState !== "none";
    }

    /** Play hit reaction with root motion, then plant physics under the animated hips. */
    public applyHitReaction(reaction: HitReaction) {
        const anim = hitReactionAnimName(reaction);
        const duration = this.human.playAnimation(anim);
        this.hitReaction = reaction;
        this.hitPhase = "react";
        this.hitReactionTimer = duration > 0 ? duration : 1.0;
        // Capture hips before root motion accumulates (delta baked on end)
        this.hasHitStartHips = this.human.getRootWorldPosition(this.hitStartHips);
        this.isLeftMouseDown = false;
        this.isRightMouseDown = false;
        this.attackTimer = 0;
        this.isPickingUp = false;
        this.isThrowing = false;
    }

    private endHitReaction() {
        // Sweep fall → bake once → sit to stand → idle (no second bake; that pulled us back)
        if (this.hitReaction === "sweep" && this.hitPhase === "react") {
            if (this.hasHitStartHips) {
                this.human.applyRootMotionDelta(
                    this.hitStartHips,
                    this.rootMotionBufferFor(this.hitReaction)
                );
                this.hasHitStartHips = false;
            }
            this.hitPhase = "getUp";
            const duration = this.human.playAnimation("sit to stand");
            this.hitReactionTimer = duration > 0 ? duration : 1.5;
            if (this.onHitRepositioned) {
                this.onHitRepositioned(
                    this.human.mesh.position.clone(),
                    this.human.mesh.quaternion.clone()
                );
            }
            return;
        }

        if (this.hitPhase === "getUp") {
            // Stay at the post-sweep planted position
            this.hasHitStartHips = false;
            this.hitReaction = null;
            this.hitPhase = "none";
            this.hitReactionTimer = 0;
            this.human.playAnimation("idle");
            if (this.onHitRepositioned) {
                this.onHitRepositioned(
                    this.human.mesh.position.clone(),
                    this.human.mesh.quaternion.clone()
                );
            }
            return;
        }

        // uppercut / side → plant then idle
        if (this.hasHitStartHips) {
            this.human.applyRootMotionDelta(
                this.hitStartHips,
                this.rootMotionBufferFor(this.hitReaction)
            );
            this.hasHitStartHips = false;
        }
        this.hitReaction = null;
        this.hitPhase = "none";
        this.hitReactionTimer = 0;
        this.human.playAnimation("idle");
        if (this.onHitRepositioned) {
            this.onHitRepositioned(
                this.human.mesh.position.clone(),
                this.human.mesh.quaternion.clone()
            );
        }
    }

    private tickHitCooldowns(dt: number) {
        for (const [id, remaining] of this.hitCooldowns) {
            const next = remaining - dt;
            if (next <= 0) this.hitCooldowns.delete(id);
            else this.hitCooldowns.set(id, next);
        }
    }

    private resolveAttackKind(): "punch one" | "punch two" | "drop kick" | null {
        const anim = this.human.activeAnimationName ?? "";
        if (anim.includes("drop kick")) return "drop kick";
        if (anim.includes("punch two")) return "punch two";
        if (anim.includes("punch")) return "punch one";
        return null;
    }

    /** True when attacker stands in front of the victim's facing direction. */
    private isAttackFromFront(
        victimPos: THREE.Vector3,
        victimQuat: THREE.Quaternion
    ): boolean {
        this.victimFwd.set(0, 0, 1).applyQuaternion(victimQuat);
        this.victimFwd.y = 0;
        if (this.victimFwd.lengthSq() < 1e-6) return true;
        this.victimFwd.normalize();

        this.toAttacker
            .copy(this.human.mesh.position)
            .sub(victimPos);
        this.toAttacker.y = 0;
        if (this.toAttacker.lengthSq() < 1e-6) return true;
        this.toAttacker.normalize();

        return this.victimFwd.dot(this.toAttacker) >= HumanInput.FRONT_DOT;
    }

    private pickReaction(
        attack: "punch one" | "punch two" | "drop kick",
        fromFront: boolean
    ): HitReaction {
        if (attack === "punch one") {
            return fromFront ? "uppercut" : "side";
        }
        // punch two / drop kick
        return fromFront ? "sweep" : "side";
    }

    private tryPunchHits() {
        if (!this.onPunchHit || !this.getPunchTargets) return;

        const attack = this.resolveAttackKind();
        if (!attack) return;

        // Only test during the forward portion of the swing
        const progress =
            this.attackDuration > 0
                ? 1 - this.attackTimer / this.attackDuration
                : 0.5;
        if (progress < 0.25 || progress > 0.85) return;

        const hasHand = this.human.getRightHandWorldPosition(this.handPos);
        const targets = this.getPunchTargets();
        for (const target of targets) {
            if (this.hitCooldowns.has(target.id)) continue;

            const radius =
                attack === "drop kick"
                    ? HumanInput.DROP_KICK_RADIUS
                    : HumanInput.CONTACT_RADIUS;

            let inContact = false;
            if (hasHand) {
                const dHead = this.handPos.distanceTo(target.head);
                const dBody = this.handPos.distanceTo(target.spine);
                inContact = dHead <= radius || dBody <= radius;
            }
            if (!inContact) {
                const dx = this.human.mesh.position.x - target.position.x;
                const dz = this.human.mesh.position.z - target.position.z;
                inContact = Math.hypot(dx, dz) <= radius + 0.35;
            }
            if (!inContact) continue;

            const fromFront = this.isAttackFromFront(
                target.position,
                target.quaternion
            );
            const reaction = this.pickReaction(attack, fromFront);
            this.hitCooldowns.set(target.id, HumanInput.HIT_COOLDOWN_SEC);
            this.onPunchHit(target.id, reaction);
        }
    }

    public update(dt: number, camera: THREE.PerspectiveCamera) {
        this.tickHitCooldowns(dt);
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
        // Relaxed grounded check for jumping on uneven terrain
        const canJump = Math.abs(currentVel.y) < 2.0;
        if (this.isEnabled && this.keys[" "] && canJump && now - this.lastJumpTime > this.jumpDuration * 1000) {
            // currentVel.y = this.jumpForce; // Animation has root motion, no physics jump
            this.lastJumpTime = now;
            
            const isRunning = this.keys["shift"];
            const animName = (isRunning && this.human.animations.has("running jumb")) ? "running jumb" : "jumbing";
            const duration = this.human.playAnimation(animName);
            if (duration > 0) {
                this.jumpDuration = duration;
            }
        }

        if (this.knockbackTimer > 0) {
            this.knockbackTimer -= dt;
        }

        if (this.hitReactionTimer > 0) {
            this.hitReactionTimer -= dt;
            // Hold still while root motion plays on the skeleton
            this.human.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            if (this.hitPhase === "getUp") {
                this.human.playAnimation("sit to stand");
            } else if (this.hitReaction) {
                this.human.playAnimation(hitReactionAnimName(this.hitReaction));
            }
            if (this.hitReactionTimer <= 0) {
                this.endHitReaction();
            }
            return;
        }

        if (this.recoveryState !== "none") {
            this.recoveryTimer -= dt;
            if (this.recoveryState === "fall") {
                this.human.playAnimation("fall down");
                if (this.recoveryTimer <= 0) {
                    this.recoveryState = "sitToStand";
                    const duration = this.human.playAnimation("sit to stand");
                    this.recoveryTimer = duration > 0 ? duration : 2.0;
                }
            } else if (this.recoveryState === "sitToStand") {
                this.human.playAnimation("sit to stand");
                if (this.recoveryTimer <= 0) {
                    this.recoveryState = "none";
                }
            } else if (this.recoveryState === "sweepFall") {
                this.human.playAnimation("sweep fall");
                if (this.recoveryTimer <= 0) {
                    this.recoveryState = "standToSit";
                    const duration = this.human.playAnimation("stand to sit");
                    this.recoveryTimer = duration > 0 ? duration : 2.0;
                }
            } else if (this.recoveryState === "standToSit") {
                this.human.playAnimation("stand to sit");
                if (this.recoveryTimer <= 0) {
                    this.recoveryState = "none";
                }
            }
            return; // Skip input processing during recovery
        }

        if (this.knockbackTimer > 0) {
            if (currentVel.y < -4.0 || now - this.lastJumpTime < this.jumpDuration * 1000) {
                if (isRunning && (forward !== 0 || right !== 0) && this.human.animations.has("running jumb")) {
                    this.human.playAnimation("running jumb");
                } else if (this.human.animations.has("jumbing")) {
                    this.human.playAnimation("jumbing");
                }
            }
            return; // Skip input processing to allow physics engine to move the character
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
            }
        } else if (this.isThrowing) {
            const previousTimer = this.throwTimer;
            this.throwTimer += dt;
            const progress = this.throwTimer / this.throwDuration;
            
            this.human.throwProgress = progress;

            // Throw at the 75% mark of the animation (when arm swings forward)
            if (previousTimer < 0.75 * this.throwDuration && this.throwTimer >= 0.75 * this.throwDuration) {
                if (this.onThrowObject && this.targetPickupObject) {
                    this.onThrowObject(this.targetPickupObject);
                }
            }

            if (progress >= 1.0) {
                this.isThrowing = false;
                this.human.throwProgress = 0;
                this.targetPickupObject = null;
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
        
        this.cameraRight.crossVectors(this.cameraFwd, this.upAxis).normalize();

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
            this.targetRotation.setFromAxisAngle(this.upAxis, angle);
            
            // Smoothly interpolate current rotation to target rotation
            this.human.mesh.quaternion.slerp(this.targetRotation, dt * this.rotationSmoothness);
        } else {
            // Apply preserved vertical velocity even when not moving horizontally
            this.human.body.setLinvel({
                x: 0,
                y: currentVel.y,
                z: 0
            }, true);
        }

        // Swimming logic & Buoyancy
        const waterSurfaceY = -0.5;
        const meshY = this.human.mesh.position.y;
        const distToPond = Math.hypot(this.human.mesh.position.x - (-20), this.human.mesh.position.z - 5);
        const isInPond = distToPond < 10; // Pond radius is 10
        
        // Hysteresis: start swimming deep, stop swimming when almost fully out
        if (isInPond) {
            if (meshY <= waterSurfaceY - 0.7) {
                this.isSwimming = true;
            } else if (meshY > waterSurfaceY - 0.2) {
                this.isSwimming = false;
            }
        } else {
            this.isSwimming = false;
        }

        if (this.isSwimming) {
            // Target meshY is waterSurfaceY - 1.5 so the body is fully submerged for underwater swimming
            const targetMeshY = waterSurfaceY - 1.5;
            const depth = targetMeshY - meshY; 
            
            const vel = this.human.body.linvel();
            const targetYVel = depth * 4.0;
            this.human.body.setLinvel({ 
                x: vel.x, 
                y: vel.y + (targetYVel - vel.y) * 5.0 * dt, 
                z: vel.z 
            }, true);
        }

        // Check for holding left click for punch two
        if (this.isLeftMouseDown && performance.now() - this.leftMouseDownTime > 300) {
            if (this.human.activeAnimationName && !this.human.activeAnimationName.includes("punch two")) {
                const duration = this.human.playAnimation("punch two");
                this.attackTimer = duration;
                this.attackDuration = duration;
            } else if (this.attackTimer <= 0.1) { 
                // Loop it seamlessly if still held at the end
                const duration = this.human.playAnimation("punch two");
                this.attackTimer = duration;
                this.attackDuration = duration;
            }
        }

        // Animation state machine
        if (this.attackTimer > 0) {
            this.attackTimer -= dt;
            this.tryPunchHits();
        } else if (this.isSwimming) {
            this.human.playAnimation("swim");
        } else if (currentVel.y < -4.0 || performance.now() - this.lastJumpTime < this.jumpDuration * 1000) {
            if (isRunning && this.moveDir.lengthSq() > 0.01 && this.human.animations.has("running jumb")) {
                this.human.playAnimation("running jumb");
            } else if (this.human.animations.has("jumbing")) {
                this.human.playAnimation("jumbing");
            }
        } else if (this.moveDir.lengthSq() > 0.01) {
            if (this.isCarryingPlayer) {
                this.human.playAnimation("carry walk");
            } else {
                this.human.playAnimation(isRunning ? "run" : "walk");
            }
        } else if (this.isPickingUp) {
            this.human.playAnimation("lift");
        } else if (this.isThrowing) {
            this.human.playAnimation("throw");
        } else {
            if (this.isCarryingPlayer) {
                this.human.playAnimation("carry idle");
            } else {
                this.human.playAnimation("idle");
            }
        }
    }
}
