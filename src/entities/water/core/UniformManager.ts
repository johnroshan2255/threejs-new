import type { IUniform } from 'three';

/**
 * Central typed access to shader uniforms.
 *
 * Materials and passes share this helper so uniform names stay consistent
 * without scattering `material.uniforms.foo.value =` across the codebase.
 */
export class UniformManager {
  private readonly uniforms: Record<string, IUniform>;

  constructor(uniforms: Record<string, IUniform> = {}) {
    this.uniforms = uniforms;
  }

  /** Return the underlying uniforms object (for ShaderMaterial). */
  getAll(): Record<string, IUniform> {
    return this.uniforms;
  }

  /** Read a uniform value by name. */
  get<T = unknown>(name: string): T | undefined {
    return this.uniforms[name]?.value as T | undefined;
  }

  /** Set a uniform value, creating the entry if missing. */
  set<T>(name: string, value: T): void {
    if (this.uniforms[name]) {
      this.uniforms[name].value = value;
      return;
    }

    this.uniforms[name] = { value };
  }

  /** Whether a uniform key exists. */
  has(name: string): boolean {
    return name in this.uniforms;
  }

  /**
   * Swap a plain entry for a TSL node, carrying its current value across.
   *
   * TSL uniform and texture nodes expose the same `.value` an `IUniform` does,
   * so once promoted every existing `set()` call keeps working unchanged — the
   * write now lands on something the node graph can read directly instead of on
   * a bag that has to be handed to a ShaderMaterial.
   */
  promote<T extends { value: unknown }>(name: string, node: T): T {
    const current = this.uniforms[name]?.value;
    if (current !== undefined && current !== null) {
      node.value = current;
    }
    this.uniforms[name] = node as unknown as IUniform;
    return node;
  }
}
