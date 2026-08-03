export type WeaponId = "fists" | "gun";

export type WeaponSlot = {
	id: WeaponId;
	label: string;
	/** Short label for the wheel icon ring. */
	short: string;
};

export const WEAPON_SLOTS: WeaponSlot[] = [
	{ id: "fists", label: "Fists", short: "👊" },
	{ id: "gun", label: "Gun", short: "🔫" },
];

/** Local loadout — fists + free gun. Bomb is a temporary world pickup, not a slot. */
export class WeaponInventory {
	public equipped: WeaponId = "fists";

	public equip(id: WeaponId): boolean {
		if (this.equipped === id) return false;
		this.equipped = id;
		return true;
	}

	public isGun(): boolean {
		return this.equipped === "gun";
	}

	public isFists(): boolean {
		return this.equipped === "fists";
	}
}
