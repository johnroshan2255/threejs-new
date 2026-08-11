# Complete Project Optimization Blueprint (Categorized)

This exhaustive blueprint outlines the critical performance bottlenecks in your codebase, categorized by the hardware resource they impact the most: **RAM**, **CPU**, **VRAM**, and **GPU**.

Follow these exact steps to rebuild the game for maximum performance.

---

# 🧠 1. RAM (System Memory)
*RAM issues in JavaScript are typically caused by instantiating new objects inside hot paths (functions that run 60-144 times a second, like `render`). This causes memory usage to rapidly balloon until the Garbage Collector has to pause your game to clean it up.*

### 🔴 Vector & Object Allocations in Hot Paths
**The Issue**: You are constantly allocating `new THREE.Vector3()`, `new THREE.Quaternion()`, and anonymous objects `{}`.
**The Fix**: Pre-allocate these objects outside the loops or as private class properties, and reuse them using `.copy()`, `.set()`, or `.applyQuaternion()`.

**Specific Files & Lines to Fix**:
- **`src/main.ts` (Lines 3796-3799 & 4201-4204)**:
  - *Code*: `const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(...)` (Used when you carry or are carried by players).
  - *Fix*: Define `private readonly _carryFwd = new THREE.Vector3();` at the class level. Inside the `render()` loop, use `this._carryFwd.set(0,0,1).applyQuaternion(...)`.
- **`src/main.ts` (Lines 3838, 3851, 3882, 3897, 3911)**:
  - *Code*: `new THREE.Vector3(0, 0.8, -1.5)` and `new THREE.Vector3(Math.random()...)` created every frame for car smoke trails and explosions.
  - *Fix*: Use a module-scoped scratch vector `_tempSmokePos.set(0, 0.8, -1.5).applyQuaternion(...)`. Never instantiate inside the particle spawn loop.
- **`src/main.ts` (Lines 4241-4243 & 4267)**:
  - *Code*: `const forward = new THREE.Vector3(...)`, `const lx = new THREE.Vector3(...)`, `const rx = new THREE.Vector3(...)` created every frame *per remote player* to sync their car exhausts and offsets.
  - *Fix*: Pre-allocate `_remoteCarFwd`, `_remoteCarLx`, `_remoteCarRx` globally and reuse them inside the remote player loop.
- **`src/main.ts` (Lines 3577, 3591, 3604)**:
  - *Code*: `this.pond.createRipple({ position: ..., strength: ... });`
  - *Fix*: Change `Pond.createRipple` in `src/entities/water.ts` to accept flat arguments `createRipple(x, y, z, strength, radius)` to eliminate the object literal allocation.
- **`src/three/chaseCamera.ts` (Line 68 & 75)**:
  - *Code*: `const headOffset = new THREE.Vector3(-0.35, 0.85, -0.4);` inside the FPV `updateChaseCamera()` loop.
  - *Fix*: Move `headOffset` and `lookDir` outside the function as module-scoped `const` variables.
- **`src/entities/car/carController.ts` (Line 157-158)**:
  - *Code*: `const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);` inside `update()`.
  - *Fix*: Declare `private readonly _nitroQuat = new THREE.Quaternion()` on the `CarController` class and reuse it.
- **`src/terrain/islandHeight.ts` (Line 134 & 160)**:
  - *Code*: `return new THREE.Vector3(x, getWorldTerrainY(x, z) + clearance, z);`
  - *Fix*: Pass a `target: THREE.Vector3` parameter into these terrain functions so the caller can provide a pre-allocated vector to store the result, avoiding thousands of allocations during generation.

---

# ⚡ 2. CPU (Processing Power)
*CPU bottlenecks in WebGPU games usually stem from Javascript Garbage Collection pauses (caused by the RAM issues above), complex math calculations, or expensive bridging calls to WebAssembly (like physics).*

### 🔴 Physics Engine Queries in Hot Paths
**The Issue**: Querying Rapier3D via `.linvel()` or `.translation()` crosses the WebAssembly boundary and instantiates a new literal object (`{ x, y, z }`) on every call. Doing this dozens of times per frame destroys CPU frame times.

**Specific Files & Lines to Fix**:
- **`src/main.ts` (Lines 3573, 3587, 3601)**:
  - *Code*: `const speed = this.car.body.linvel();` (and for human/bombs) inside `render()`.
  - *Fix*: Do not use physics to calculate visual water ripples. Store `mesh.position` from the previous frame. Calculate speed as `const dx = mesh.position.x - lastPos.x; const dz = mesh.position.z - lastPos.z; const velocity = Math.hypot(dx, dz) / dt;`.
- **`src/three/chaseCamera.ts` (Line 96 & 212)**:
  - *Code*: Camera queries `car.body.linvel()` to determine auto-centering.
  - *Fix*: Have the `CarEntity` calculate its speed using mesh deltas, or cache `linvel` once per tick, and read `car.currentSpeed` from the camera.
- **`src/entities/human/HumanInput.ts` (Lines 512, 580, 893, 1115)**:
  - *Code*: Repeatedly calls `this.human.body.linvel()` across various input checks in a single frame.
  - *Fix*: Call it **once** at the very beginning of the `update(dt)` function, store it in `this._currentHumanVel`, and reference that cached variable everywhere else.
- **`src/entities/car/carController.ts` & `vehicleGrapple.ts`**:
  - *Fix*: Same caching strategy. Never call `.linvel()` more than once per entity per frame.

---

# 💾 3. VRAM (Video Memory)
*VRAM leaks occur when WebGPU resources (like large textures) are removed from the scene but not explicitly purged from the GPU's memory. Over time, switching worlds or cars will fill up VRAM until the browser crashes the game.*

### 🔴 Texture Disposal Leaks
**The Issue**: In `src/main.ts` (e.g., Line 6713 inside `disposeBombs` or when unloading worlds), you traverse objects and call `.dispose()` on geometries and materials. However, calling `material.dispose()` **does not** dispose of the textures attached to it. 

**The Fix**: You must write a recursive disposal utility for your GLTF scenes that actively disposes of `.map`, `.normalMap`, etc.

**Add this to your codebase and use it whenever you delete a mesh:**
```typescript
export function fullyDisposeObject(object: THREE.Object3D) {
    object.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                for (const mat of materials) {
                    // MUST dispose textures, otherwise they remain in VRAM permanently!
                    if (mat.map) mat.map.dispose();
                    if (mat.normalMap) mat.normalMap.dispose();
                    if (mat.roughnessMap) mat.roughnessMap.dispose();
                    if (mat.metalnessMap) mat.metalnessMap.dispose();
                    if (mat.emissiveMap) mat.emissiveMap.dispose();
                    mat.dispose();
                }
            }
        }
    });
}
```

---

# 🎮 4. GPU (Graphics Processing)
*GPU bottlenecks occur when the scene sends too many draw calls (vertex processing), runs heavy compute shaders on too many instances, or re-renders high-resolution shadow maps unnecessarily.*

### 🔴 Compute Shader & Frustum Strain
**The Issue**: `this.islandGrassField?.updateCompute(this.renderer, cullCam, cullPos)` runs every 2 frames in `src/main.ts`. If you have tens of thousands of grass instances, you are sending a massive buffer to the GPU compute shader for instances that might be miles away or behind the player.

**The Fix**: **Spatial Chunking (CPU-side)**
1. Divide the Island/Valley into grid chunks (e.g., 50x50 meters).
2. Assign grass matrices to these chunks instead of one giant global array.
3. In `updateCompute`, do a fast CPU-side Frustum and Distance check against the bounding box of each chunk.
4. Only dispatch the compute shader and render calls for chunks that are strictly within `grassCullDistance` and inside the camera's view.

### 🔴 Shadow Map Refresh Cadence
**The Issue**: In `src/main.ts:3474`, the shadow map is updated on a timer (`this.lastShadowRefresh >= this.shadowRefreshMs`), and the frustum is re-centered (`dayNight.setFocus`).
**The Fix**: Moving the frustum forces the entire scene to be re-rendered from the sun's perspective. If your shadow map is high-resolution (e.g., 2048x2048 or higher), this will severely hitch the GPU. Ensure your `shadowQuality` strictly bounds the shadow map resolution in `GameSettings.ts`, and consider using Cascaded Shadow Maps (CSM) if you want crisp shadows near the player without rendering a massive, expensive texture for the whole map.

---

# 🔎 5. Additional Minor Leaks
*Two more findings that contribute to memory bloat over longer play sessions.*

### 🔴 The `.clone()` Trap
**The Issue**: Throughout your network sync loops and rendering loops (`src/main.ts` Lines 3837, 3881, 2799, 3077), you frequently use `this.car.mesh.position.clone().add(...)`. 
**The Fix**: `.clone()` is just syntax sugar for `new THREE.Vector3()`. It instantiates a new object in RAM every single time. Treat `.clone()` inside an `update` loop as strictly forbidden. Pre-allocate a scratch vector `_tempPos.copy(this.car.mesh.position).add(...)`.

### 🔴 DOM Event Listener Leaks
**The Issue**: Across the `src` directory, you call `addEventListener` 109 times, but only call `removeEventListener` 29 times. 
**The Fix**: If any of those UI scripts or controllers are destroyed and recreated (for example, when respawning, opening menus, or swapping active players), the old event listeners remain bound to `window` or `document`. This prevents the entire UI class from being garbage collected, causing a "Ghost Leak" that permanently eats RAM. Ensure every `addEventListener` has a corresponding `removeEventListener` inside a `dispose()` method.
