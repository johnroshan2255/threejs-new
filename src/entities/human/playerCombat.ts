/** Shared combat / HP constants for local + remote players. */
export const PLAYER_MAX_HP = 100;
export const DAMAGE_HEAD = 50; // 2 headshots to kill
export const DAMAGE_BODY = 10; // 10 body shots to kill
export const DAMAGE_BOMB = 100; // instant kill
export const BLAST_KILL_RADIUS = 3.5;

export type GunHitPart = "head" | "body";
export type DeathCause = "gun" | "bomb";

export function damageForPart(part: GunHitPart): number {
	return part === "head" ? DAMAGE_HEAD : DAMAGE_BODY;
}
