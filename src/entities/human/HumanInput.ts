import * as THREE from "three";
import {
	HumanEntity,
	hitReactionAnimName,
	type HitReaction,
} from "./HumanEntity";
import { WeaponInventory, type WeaponId } from "./WeaponInventory";
import { type MobileControls } from "../../ui/mobileControls";
import { WeaponWheel } from "../../ui/WeaponWheel";
import { GunSound } from "../../audio/GunSound";
import {
	isGameKeyBlocked,
	isTextEntryTarget,
	isUiPointerTarget,
} from "../../ui/gameInputFocus";

export class HumanInput {
    private _isEnabled = false;
    public get isEnabled() { return this._isEnabled; }
    public set isEnabled(v: boolean) {
        if (this._isEnabled === v) return;
        this._isEnabled = v;
        if (!v) {
            this.releaseControls();
        }
    }
    private human: HumanEntity;
    private keys: { [key: string]: boolean } = {};
    private walkSpeed = 2.0;
    private runSpeed = 6.0;
    private jumpForce = 8.0;
    private rotationSmoothness = 10.0;
    
    private lastJumpTime = 0;
    private jumpDuration = 0.8;

    /**
     * Horizontal-only braking, replacing the body's old isotropic linearDamping
     * of 4.0 (which also capped fall speed at ~2.45 m/s). Same 4.0 rate, so
     * ground feel is unchanged; Y is now left to gravity.
     */
    private static readonly HORIZONTAL_BRAKE = 4.0;
    /** Limp on the ground during recovery — stop sliding fast. */
    private static readonly RECOVERY_BRAKE = 8.0;
    /** Knockback should carry, so bleed it off gently. */
    private static readonly KNOCKBACK_BRAKE = 1.5;
    /**
     * Fall velocity that switches to the airborne animation. Must stay well
     * inside real terminal velocity — the old -4.0 was unreachable when damping
     * capped falls at 2.45 m/s, so the fall anim never played.
     */
    private static readonly FALL_ANIM_VY = -6.0;

    /** Fists vs free gun — bomb is a temporary world pickup. */
    public readonly inventory = new WeaponInventory();
    private weaponWheel: WeaponWheel | null = null;
    /** GTA toggle aim — RMB click locks/unlocks ADS (not hold). */
    private aimLocked = false;
    private isShooting = false;
    private shootTimer = 0;
    private shootDuration = 0;
    /** Time until next bullet can fire (auto / tap). */
    private fireCooldown = 0;
    private static readonly FIRE_INTERVAL = 0.11;
    private readonly shootCooldown = new Map<string, number>();
    private static readonly SHOOT_RANGE = 80;
    private static readonly SHOOT_HIT_RADIUS = 1.1;
    private static readonly SHOOT_COOLDOWN_SEC = 0.12;
    private readonly shootOrigin = new THREE.Vector3();
    private readonly shootDir = new THREE.Vector3();
    private readonly shootToTarget = new THREE.Vector3();
    private readonly shootClosest = new THREE.Vector3();
    private readonly aimPoint = new THREE.Vector3();
    private readonly camWorldPos = new THREE.Vector3();
    private crosshairEl: HTMLElement | null = null;
    /** Last camera passed to update — used when firing from mousedown. */
    private lastCamera: THREE.PerspectiveCamera | null = null;
    
    // Procedural Pickup
    private isPickingUp = false;
    private pickupTimer = 0;
    private pickupDuration = 1.0;
    private targetPickupObject: THREE.Object3D | null = null;
    public checkCanPickup: (() => THREE.Object3D | null) | null = null;
    public checkIsHoldingObject: (() => THREE.Object3D | null) | null = null;
    public onGrabObject: ((obj: THREE.Object3D) => void) | null = null;
    public onThrowObject: ((obj: THREE.Object3D) => void) | null = null;
    /** Fired when fists/gun selection changes (for showing gun mesh). */
    public onWeaponEquip: ((id: WeaponId) => void) | null = null;
    /** Pause/resume pointer-lock mouse look while the weapon wheel is open. */
    public onWeaponWheelToggle: ((open: boolean) => void) | null = null;
    /** Optional gun hit callback (when projectile actually hits a body). */
    public onGunHit: ((targetId: string, part: "head" | "body") => void) | null = null;
    /**
     * Spawn a physical/visual bullet. Prefer this over instant hitscan.
     * origin = muzzle, dir = aim direction (normalized by system).
     */
    public onFireProjectile:
        | ((origin: THREE.Vector3, direction: THREE.Vector3) => void)
        | null = null;
    /** World position of the gun muzzle tip (optional). */
    public getMuzzleWorldPosition: (() => THREE.Vector3 | null) | null = null;
    
    // Player carrying
    public isCarryingPlayer = false;
    public checkCanPickupPlayer: (() => string | null) | null = null; // returns socketId
    public onGrabPlayer: ((socketId: string) => void) | null = null;
    public onThrowPlayer: ((socketId: string) => void) | null = null;
    public carriedPlayerId: string | null = null;

    /** Returns remote targets with approx head/spine world positions for punch tests. */
    public getPunchTargets?: () => Array<{
        id: string;
        head: THREE.Vector3;
        spine: THREE.Vector3;
        feetY: number;
        position: THREE.Vector3;
        quaternion: THREE.Quaternion;
    }>;
    public customShootRaycast?: (origin: THREE.Vector3, dir: THREE.Vector3) => { id: string, dist: number } | null;

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

        this.weaponWheel = new WeaponWheel({
            getEquipped: () => this.inventory.equipped,
            onSelect: (id) => this.equipWeapon(id),
        });

        this.crosshairEl = document.createElement("div");
        this.crosshairEl.className = "gun-crosshair";
        this.crosshairEl.setAttribute("aria-hidden", "true");
        this.crosshairEl.innerHTML =
            '<span class="gc-h"></span><span class="gc-v"></span><span class="gc-dot"></span>';
        document.body.appendChild(this.crosshairEl);

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
        this.weaponWheel?.dispose();
        this.weaponWheel = null;
        this.crosshairEl?.remove();
        this.crosshairEl = null;
        this.onWeaponWheelToggle?.(false);
    }

    public get equippedWeapon(): WeaponId {
        return this.inventory.equipped;
    }

    public equipWeapon(id: WeaponId) {
        // Don't swap loadout mid bomb lift/throw or while a bomb is in hand
        if (this.isPickingUp || this.isThrowing) return;
        if (this.checkIsHoldingObject?.()) return;
        if (!this.inventory.equip(id)) {
            this.syncWeaponVisual();
            return;
        }
        this.isShooting = false;
        this.shootTimer = 0;
        this.aimLocked = false;
        this.fireCooldown = 0;
        this.syncWeaponVisual();
    }

    /** True when the gun mesh should be visible in the right hand. */
    public shouldShowGun(): boolean {
        return (
            this.inventory.isGun() &&
            !this.isHoldingBomb() &&
            !this.isPickingUp &&
            !this.isThrowing
        );
    }

    /** GTA toggle ADS — locked until RMB clicked again (or auto-locked by firing). */
    public isAimingGun(): boolean {
        return this.gunModeActive() && this.aimLocked;
    }

    /** True while spraying with LMB in ADS (for network tick sync). */
    public isFiringGun(): boolean {
        return this.isAimingGun() && this.isLeftMouseDown;
    }

    /** Block combat / movement while dead (respawn pending). */
    public isDead = false;

    /** LMB without prior RMB: enter ADS so you can shoot immediately (incl. while walking). */
    private ensureAimForFire() {
        if (!this.gunModeActive()) return false;
        if (!this.aimLocked) {
            this.aimLocked = true;
            this.syncAimUi();
        }
        return true;
    }

    public clearAimLock() {
        this.aimLocked = false;
        this.isShooting = false;
        this.shootTimer = 0;
        this.fireCooldown = 0;
        this.syncAimUi();
    }

    private syncWeaponVisual() {
        this.onWeaponEquip?.(this.inventory.equipped);
        this.syncAimUi();
    }

    private syncAimUi() {
        this.crosshairEl?.classList.toggle("is-visible", this.isAimingGun());
    }

    private openWeaponWheel() {
        if (this.weaponWheel?.isOpen()) return;
        this.weaponWheel?.show();
        this.onWeaponWheelToggle?.(true);
    }

    private closeWeaponWheel(commit: boolean) {
        if (!this.weaponWheel?.isOpen()) return;
        this.weaponWheel.hide(commit);
        this.onWeaponWheelToggle?.(false);
    }

    private isHoldingBomb(): boolean {
        return Boolean(this.checkIsHoldingObject?.());
    }

    private gunModeActive(): boolean {
        return this.inventory.isGun() && !this.isHoldingBomb() && !this.isPickingUp && !this.isThrowing;
    }

    public setMobileControls(mc: MobileControls) {
        this.mobileControls = mc;
    }

    /** Drop every held key / button (form focus, leaving the game). */
    public releaseControls() {
        this.keys = {};
        this.isLeftMouseDown = false;
        this.isRightMouseDown = false;
        this.clearAimLock();
        this.weaponWheel?.hide(false);
        this.onWeaponWheelToggle?.(false);
    }

    /** Called when leaving human control so the wheel cannot stay open. */
    public forceCloseWeaponWheel() {
        this.closeWeaponWheel(false);
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
        if (k === "q" && !e.repeat) {
            e.preventDefault();
            this.openWeaponWheel();
        }
    };

    private onKeyUp = (e: KeyboardEvent) => {
        if (!e.key) return;
        const k = e.key.toLowerCase();
        this.keys[k] = false;
        if (k === "q") {
            this.closeWeaponWheel(true);
        }
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
        if (this.weaponWheel?.isOpen()) return;
        if (this.isCarryingPlayer) return; // Disable punches when carrying a player
        if (this.isHoldingBomb() || this.isPickingUp || this.isThrowing) return;

        if (this.hitReactionTimer > 0) return;

        if (this.gunModeActive()) {
            // RMB: toggle aim lock only (no fire)
            if (e.button === 2) {
                this.aimLocked = !this.aimLocked;
                if (!this.aimLocked) {
                    this.isShooting = false;
                    this.shootTimer = 0;
                    this.fireCooldown = 0;
                }
                this.syncAimUi();
            } else if (e.button === 0) {
                // LMB: auto-ADS if needed, then shoot (works from rifle walk too)
                this.isLeftMouseDown = true;
                if (this.ensureAimForFire()) {
                    this.isShooting = true;
                    this.human.playAnimation("gunplay", 0.12, false, "repeat");
                    this.fireBullet(this.lastCamera);
                }
            }
            return;
        }

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
            if (this.inventory.isGun()) {
                // End spray — next frame returns to rifle idle
                this.isShooting = false;
                this.shootTimer = 0;
            }
        } else if (e.button === 2) {
            this.isRightMouseDown = false;
            // Aim stays locked until RMB is clicked again (toggle)
        }
    };

    /** Discrete shot: sound + spawn projectile aimed through screen-center crosshair. */
    private fireBullet(camera: THREE.PerspectiveCamera | null) {
        if (!this.isAimingGun()) return;
        if (this.fireCooldown > 0) return;

        this.fireCooldown = HumanInput.FIRE_INTERVAL;
        GunSound.playShot(this.human.mesh.position);

        if (!camera) return;
        camera.updateMatrixWorld(true);
        camera.getWorldPosition(this.camWorldPos);
        camera.getWorldDirection(this.shootDir);

        // Always aim through exact screen-center crosshair — no target snap.
        this.aimPoint
            .copy(this.camWorldPos)
            .addScaledVector(this.shootDir, HumanInput.SHOOT_RANGE);

        const muzzle = this.getMuzzleWorldPosition?.();
        if (muzzle) {
            this.shootOrigin.copy(muzzle);
        } else {
            this.shootOrigin
                .copy(this.camWorldPos)
                .addScaledVector(this.shootDir, 1.2);
        }

        this.shootDir.copy(this.aimPoint).sub(this.shootOrigin);
        if (this.shootDir.lengthSq() < 1e-6) {
            camera.getWorldDirection(this.shootDir);
        } else {
            this.shootDir.normalize();
        }

        if (this.onFireProjectile) {
            this.onFireProjectile(this.shootOrigin, this.shootDir);
        } else {
            this.tryShootHits(camera, true);
        }
    }

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
                    this.isShooting = false;
                    this.pickupTimer = 0;
                    this.throwTimer = 0;
                    this.targetPickupObject = heldObj;
                    this.syncWeaponVisual();
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
            this.isShooting = false;
            this.clearAimLock();
            this.pickupTimer = 0;
            this.syncWeaponVisual();
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

    /**
     * Exponential decay on x/z only, leaving y to gravity. Used by the update
     * paths that return before the movement setLinvel and so would otherwise
     * slide forever now that linearDamping is ~0.
     */
    private brakeHorizontal(rate: number, dt: number) {
        const vel = this.human.body.linvel();
        const keep = 1 / (1 + rate * dt);
        this.human.body.setLinvel(
            { x: vel.x * keep, y: vel.y, z: vel.z * keep },
            true
        );
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
        if (this.gunModeActive() || this.isShooting) return;

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

    private tryShootHits(
        camera: THREE.PerspectiveCamera,
        immediate: boolean = false
    ) {
        if (!this.onGunHit || !this.getPunchTargets) return;
        if (!this.isAimingGun()) return;
        if (!immediate && !this.isShooting) return;

        // Hitscan along camera forward (= screen-center crosshair while ADS)
        camera.updateMatrixWorld(true);
        this.shootOrigin.setFromMatrixPosition(camera.matrixWorld);
        camera.getWorldDirection(this.shootDir);

        const targets = this.getPunchTargets();
        let bestId: string | null = null;
        let bestDist = HumanInput.SHOOT_RANGE;

        for (const target of targets) {
            if (this.shootCooldown.has(target.id)) continue;

            // Test both torso and head; take the closer hit along the ray
            for (const aimPoint of [target.spine, target.head]) {
                this.shootToTarget.copy(aimPoint).sub(this.shootOrigin);
                const along = this.shootToTarget.dot(this.shootDir);
                if (along < 1.0 || along > bestDist) continue;

                this.shootClosest
                    .copy(this.shootOrigin)
                    .addScaledVector(this.shootDir, along);
                if (
                    this.shootClosest.distanceTo(aimPoint) >
                    HumanInput.SHOOT_HIT_RADIUS
                ) {
                    continue;
                }
                bestDist = along;
                bestId = target.id;
            }
        }

        if (this.customShootRaycast) {
            const customHit = this.customShootRaycast(this.shootOrigin, this.shootDir);
            if (customHit && customHit.dist < bestDist) {
                bestDist = customHit.dist;
                bestId = customHit.id;
            }
        }

        if (bestId) {
            this.shootCooldown.set(bestId, HumanInput.SHOOT_COOLDOWN_SEC);
            this.onGunHit(bestId, "body");
            this.crosshairEl?.classList.add("is-hit");
            window.setTimeout(() => {
                this.crosshairEl?.classList.remove("is-hit");
            }, 80);
        }
    }

    public update(dt: number, camera: THREE.PerspectiveCamera) {
        this.lastCamera = camera;
        if (this.isDead) {
            this.releaseControls();
            this.clearAimLock();
            return;
        }
        this.tickHitCooldowns(dt);
        for (const [id, t] of this.shootCooldown) {
            const next = t - dt;
            if (next <= 0) this.shootCooldown.delete(id);
            else this.shootCooldown.set(id, next);
        }
        if (this.fireCooldown > 0) {
            this.fireCooldown = Math.max(0, this.fireCooldown - dt);
        }

        let forward = 0;
        let right = 0;
        
        if (this.isEnabled && !this.weaponWheel?.isOpen()) {
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

        // Gun out: walk only. Extra slow while ADS (GTA-like).
        const wantsRun = Boolean(this.keys["shift"]) && !this.gunModeActive();
        const isRunning = wantsRun;
        const currentSpeed = this.isAimingGun()
            ? this.walkSpeed * 0.55
            : isRunning
                ? this.runSpeed
                : this.walkSpeed;

        // Jump Logic
        const currentVel = this.human.body.linvel();
        const now = performance.now();
        // Relaxed grounded check for jumping on uneven terrain
        const canJump = Math.abs(currentVel.y) < 2.0;
        if (this.isEnabled && this.keys[" "] && canJump && now - this.lastJumpTime > this.jumpDuration * 1000) {
            // currentVel.y = this.jumpForce; // Animation has root motion, no physics jump
            this.lastJumpTime = now;
            
            const animName =
                isRunning && this.human.animations.has("running jumb")
                    ? "running jumb"
                    : "jumbing";
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
            // This path returns before the movement setLinvel below, so brake here.
            this.brakeHorizontal(HumanInput.RECOVERY_BRAKE, dt);
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
            // Also returns early — bleed the impulse off gently instead of via damping.
            this.brakeHorizontal(HumanInput.KNOCKBACK_BRAKE, dt);
            if (currentVel.y < HumanInput.FALL_ANIM_VY || now - this.lastJumpTime < this.jumpDuration * 1000) {
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
                this.syncWeaponVisual();
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

            if (this.isAimingGun()) {
                // ADS: face camera look (GTA) so strafe keeps aim forward
                camera.getWorldDirection(this.cameraFwd);
                this.cameraFwd.y = 0;
                if (this.cameraFwd.lengthSq() > 1e-4) {
                    this.cameraFwd.normalize();
                    const angle = Math.atan2(this.cameraFwd.x, this.cameraFwd.z);
                    this.targetRotation.setFromAxisAngle(this.upAxis, angle);
                    this.human.mesh.quaternion.slerp(
                        this.targetRotation,
                        dt * this.rotationSmoothness * 1.4
                    );
                }
            } else {
                // Hip / fists: face walk direction
                const angle = Math.atan2(this.moveDir.x, this.moveDir.z);
                this.targetRotation.setFromAxisAngle(this.upAxis, angle);
                this.human.mesh.quaternion.slerp(this.targetRotation, dt * this.rotationSmoothness);
            }
        } else {
            // Apply preserved vertical velocity even when not moving horizontally
            this.human.body.setLinvel({
                x: 0,
                y: currentVel.y,
                z: 0
            }, true);

            // Idle ADS: face camera aim
            if (this.isAimingGun()) {
                camera.getWorldDirection(this.cameraFwd);
                this.cameraFwd.y = 0;
                if (this.cameraFwd.lengthSq() > 1e-4) {
                    this.cameraFwd.normalize();
                    const angle = Math.atan2(this.cameraFwd.x, this.cameraFwd.z);
                    this.targetRotation.setFromAxisAngle(this.upAxis, angle);
                    this.human.mesh.quaternion.slerp(
                        this.targetRotation,
                        dt * this.rotationSmoothness * 1.4
                    );
                }
            }
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

        // Gravity off while submerged so the buoyancy lerp below isn't fighting it.
        this.human.setBuoyant(this.isSwimming);

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

        // Hold LMB for punch two — fists only
        if (
            !this.gunModeActive() &&
            this.isLeftMouseDown &&
            performance.now() - this.leftMouseDownTime > 300
        ) {
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

        // Hold LMB: auto-ADS + looping Gunplay + fire (also while moving / rifle walk)
        if (this.gunModeActive() && this.isLeftMouseDown) {
            this.ensureAimForFire();
            this.isShooting = true;
            this.human.playAnimation("gunplay", 0.12, false, "repeat");
            this.fireBullet(camera);
        } else if (this.isShooting) {
            this.isShooting = false;
            this.shootTimer = 0;
        }

        // Animation state machine
        if (this.gunModeActive() && this.isLeftMouseDown) {
            // Gunplay held above — do not fall through to rifle walk/idle
        } else if (this.attackTimer > 0 && !this.gunModeActive()) {
            this.attackTimer -= dt;
            this.tryPunchHits();
        } else if (this.isSwimming) {
            this.human.playAnimation("swim");
        } else if (currentVel.y < HumanInput.FALL_ANIM_VY || performance.now() - this.lastJumpTime < this.jumpDuration * 1000) {
            if (isRunning && this.moveDir.lengthSq() > 0.01 && this.human.animations.has("running jumb")) {
                this.human.playAnimation("running jumb");
            } else if (this.human.animations.has("jumbing")) {
                this.human.playAnimation("jumbing");
            }
        } else if (this.isPickingUp) {
            this.human.playAnimation("lift");
        } else if (this.isThrowing) {
            this.human.playAnimation("throw");
        } else if (this.moveDir.lengthSq() > 0.01) {
            if (this.isCarryingPlayer) {
                this.human.playAnimation("carry walk");
            } else if (this.gunModeActive()) {
                this.human.playAnimation("rifle walk");
            } else {
                this.human.playAnimation(isRunning ? "run" : "walk");
            }
        } else {
            if (this.isCarryingPlayer) {
                this.human.playAnimation("carry idle");
            } else if (this.gunModeActive()) {
                this.human.playAnimation("rifle idle");
            } else {
                this.human.playAnimation("idle");
            }
        }
    }
}
