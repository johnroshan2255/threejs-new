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
}
