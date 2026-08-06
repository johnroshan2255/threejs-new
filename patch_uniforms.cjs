const fs = require('fs');
function patch(file) {
    let code = fs.readFileSync(file, 'utf-8');
    code = code.replace(/this\.material\.uniforms/g, '(this.material as any).uniforms');
    code = code.replace(/this\.simMaterial\.uniforms/g, '(this.simMaterial as any).uniforms');
    code = code.replace(/this\.disturbanceMaterial\.uniforms/g, '(this.disturbanceMaterial as any).uniforms');
    code = code.replace(/exp\.material\.uniforms/g, '(exp.material as any).uniforms');
    
    // Fix WebGLRenderTarget issue in RippleSimulation
    code = code.replace(/WebGLRenderer,/g, 'WebGLRenderer, WebGLRenderTarget,');
    code = code.replace(/renderer\.setRenderTarget\(this\.readTarget\)/g, 'renderer.setRenderTarget(this.readTarget as any)');
    code = code.replace(/renderer\.setRenderTarget\(this\.writeTarget\)/g, 'renderer.setRenderTarget(this.writeTarget as any)');
    
    fs.writeFileSync(file, code);
}
patch('src/entities/water/rendering/CausticsPass.ts');
patch('src/entities/water/simulation/RippleSimulation.ts');
patch('src/environment/ExplosionSystem.ts');
