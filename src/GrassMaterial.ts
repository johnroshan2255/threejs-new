import { GUI } from "dat.gui";
import * as THREE from "three";

interface GrassUniformsInterface {
	uTime?: { value: number };
	uEnableShadows?: { value: boolean };
	uShadowDarkness?: { value: number };
	uGrassLightIntensity?: { value: number };
	uGrassLightColor?: { value: THREE.Color };
	uGrassAmbientColor?: { value: THREE.Color };
	uGrassShadowTint?: { value: THREE.Color };
	uNoiseScale?: { value: number };
	uBladeHeightScale?: { value: number };
	uTerrainSize?: { value: number };
	uPlayerPosition?: { value: THREE.Vector3 };
	baseColor?: { value: THREE.Color };
	tipColor1?: { value: THREE.Color };
	tipColor2?: { value: THREE.Color };
	noiseTexture?: { value: THREE.Texture };
	grassAlphaTexture?: { value: THREE.Texture };
	fogColor2?: { value: THREE.Color };
	fogColor3?: { value: THREE.Color };
}
export class GrassMaterial {
	material: THREE.Material;

	private grassColorProps = {
		baseColor: "#1d360c",
		tipColor1: "#3f6d21",
		tipColor2: "#4c8129",
	};

	uniforms: { [key: string]: { value: any } } = {
		uTime: { value: 0 },
		uEnableShadows: { value: true },
		uShadowDarkness: { value: 0.42 },
		uGrassLightIntensity: { value: 1 },
		/** Key light colour — grass shades itself, so this is fed in per frame. */
		uGrassLightColor: { value: new THREE.Color(0xffd2a1) },
		/** Cool sky fill so the unlit side isn't just a darker green. */
		uGrassAmbientColor: { value: new THREE.Color(0x40608f) },
		/** Hue multiplier inside cast shadows (blue shadows, not grey ones). */
		uGrassShadowTint: { value: new THREE.Color(0x7d9ad6) },
		uNoiseScale: { value: 1.5 },
		/** Scales tip stretch / wind — must match blade instance height or grass stays tall. */
		uBladeHeightScale: { value: 0.6 },
		uTerrainSize: { value: 140 },
		uPlayerPosition: { value: new THREE.Vector3() },
		baseColor: { value: new THREE.Color(this.grassColorProps.baseColor) },
		tipColor1: { value: new THREE.Color(this.grassColorProps.tipColor1) },
		tipColor2: { value: new THREE.Color(this.grassColorProps.tipColor2) },
		noiseTexture: { value: new THREE.Texture() },
		grassAlphaTexture: { value: new THREE.Texture() },
	};

	private mergeUniforms(newUniforms?: GrassUniformsInterface) {
		if (!newUniforms) return;
		for (const [key, value] of Object.entries(newUniforms)) {
			if (value && this.uniforms.hasOwnProperty(key)) {
				this.uniforms[key].value = value;
			}
		}
	}
	constructor(grassProps?: GrassUniformsInterface) {
		this.mergeUniforms(grassProps);
		this.material = new THREE.MeshLambertMaterial({
			side: THREE.DoubleSide,
			color: 0x229944,
			transparent: true,
			alphaTest: 0.1,
			shadowSide: 1,
		});

		this.setupGrassMaterial(this.material);
	}

	public updateGrassGraphicsChange(high: boolean = true) {
		if (!high) {
			this.uniforms.uEnableShadows.value = false;
		} else {
			this.uniforms.uEnableShadows.value = true;
		}
	}

	update(delta: number) {
		this.uniforms.uTime.value = delta;
	}

	/**
	 * The grass shader does its own lighting and never reads the scene's key
	 * light, so the day/night colours have to be handed to it explicitly —
	 * otherwise grass stays neutral while everything else picks up the
	 * warm-key / cool-fill split.
	 */
	setLightParams(p: {
		keyColor: THREE.Color;
		intensity: number;
		ambient: THREE.Color;
		shadowTint: THREE.Color;
	}) {
		this.uniforms.uGrassLightColor.value.copy(p.keyColor);
		this.uniforms.uGrassLightIntensity.value = p.intensity;
		this.uniforms.uGrassAmbientColor.value.copy(p.ambient);
		this.uniforms.uGrassShadowTint.value.copy(p.shadowTint);
	}

	/** Blade visual height (1 = original). Affects shader tip lift + wind amp. */
	setBladeHeightScale(scale: number) {
		this.uniforms.uBladeHeightScale.value = Math.max(0.05, scale);
	}

	private setupGrassMaterial(material: THREE.Material) {
		material.onBeforeCompile = (shader) => {
			shader.uniforms = {
				...shader.uniforms,
				uTime: this.uniforms.uTime,
				uTipColor1: this.uniforms.tipColor1,
				uTipColor2: this.uniforms.tipColor2,
				uBaseColor: this.uniforms.baseColor,
				uEnableShadows: this.uniforms.uEnableShadows,
				uShadowDarkness: this.uniforms.uShadowDarkness,
				uGrassLightIntensity: this.uniforms.uGrassLightIntensity,
				uGrassLightColor: this.uniforms.uGrassLightColor,
				uGrassAmbientColor: this.uniforms.uGrassAmbientColor,
				uGrassShadowTint: this.uniforms.uGrassShadowTint,
				uNoiseScale: this.uniforms.uNoiseScale,
				uBladeHeightScale: this.uniforms.uBladeHeightScale,
				uTerrainSize: this.uniforms.uTerrainSize,
				uNoiseTexture: this.uniforms.noiseTexture,
				uGrassAlphaTexture: this.uniforms.grassAlphaTexture,
				fogColor2: this.uniforms.fogColor2,
				fogColor3: this.uniforms.fogColor3,
			};

			shader.vertexShader = `
      // FOG
      #include <common>
      #include <fog_pars_vertex>
      // FOG
      #include <shadowmap_pars_vertex>
      uniform sampler2D uNoiseTexture;
      uniform float uNoiseScale;
      uniform float uBladeHeightScale;
      uniform float uTerrainSize;
      uniform float uTime;
      
      varying vec3 vColor;
      varying vec2 vGlobalUV;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec2 vWindColor;
      void main() {
        #include <color_vertex>
        
        // FOG
        #include <begin_vertex>
        #include <project_vertex>
        #include <fog_vertex>
        // FOG
        
        // SHADOW
        #include <beginnormal_vertex>
        #include <defaultnormal_vertex>
        #include <worldpos_vertex>
        #include <shadowmap_vertex>
        // SHADOW

        // wind effect (amp scales with blade height)
        vec2 uWindDirection = vec2(1.0,1.0);
        float uWindAmp = 0.1 * uBladeHeightScale;
        float uWindFreq = 50.;
        float uSpeed = 1.0;
        float uNoiseFactor = 5.50;
        float uNoiseSpeed = 0.001;

        vec2 windDirection = normalize(uWindDirection); // Normalize the wind direction
        vec4 modelPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);

        float terrainSize = uTerrainSize;
        vGlobalUV = (terrainSize-vec2(modelPosition.xz))/terrainSize;

        vec4 noise = texture2D(uNoiseTexture,vGlobalUV+uTime*uNoiseSpeed);

        float tip = (1.-uv.y);
        float sinWave = sin(uWindFreq*dot(windDirection, vGlobalUV) + noise.g*uNoiseFactor + uTime * uSpeed) * uWindAmp * tip;

        float xDisp = sinWave;
        float zDisp = sinWave;
        modelPosition.x += xDisp;
        modelPosition.z += zDisp;

        // Tip lift is in world units AFTER instance scale — must scale with blade height
        // or grass stays tall even when instanceMatrix Y is reduced.
        modelPosition.y += exp(texture2D(uNoiseTexture,vGlobalUV * uNoiseScale).r) * 0.5 * uBladeHeightScale * tip;

        vec4 viewPosition = viewMatrix * modelPosition;
        vec4 projectedPosition = projectionMatrix * viewPosition;
        gl_Position = projectedPosition;

        // assign varyings
        vUv = vec2(uv.x,1.-uv.y);
        vNormal = normalize(normalMatrix * normal);
        vWindColor = vec2(xDisp,zDisp);
        // Must match wind-displaced position so spot headlights hit the blades
        vViewPosition = viewPosition.xyz;
      }    
      `;

			shader.fragmentShader = `
      #include <alphatest_pars_fragment>
      #include <alphamap_pars_fragment>
      // FOG
      #include <fog_pars_fragment>
      // FOG

      #include <common>
      #include <packing>
      #include <lights_pars_begin>
      #include <shadowmap_pars_fragment>
      #include <shadowmask_pars_fragment>
      
      uniform float uTime;
      uniform vec3 uBaseColor;
      uniform vec3 uTipColor1;
      uniform vec3 uTipColor2;
      uniform sampler2D uGrassAlphaTexture;
      uniform sampler2D uNoiseTexture;
      uniform float uNoiseScale;
      uniform int uEnableShadows;
      
      uniform float uGrassLightIntensity;
      uniform vec3 uGrassLightColor;
      uniform vec3 uGrassAmbientColor;
      uniform vec3 uGrassShadowTint;
      uniform float uShadowDarkness;
      uniform float uDayTime;
      varying vec3 vColor;
      
      varying vec2 vUv;
      varying vec2 vGlobalUV;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec2 vWindColor;
      
      void main() {
        vec4 grassAlpha = texture2D(uGrassAlphaTexture,vUv);

        vec4 grassVariation = texture2D(uNoiseTexture, vGlobalUV * uNoiseScale);
        vec3 tipColor = mix(uTipColor1,uTipColor2,grassVariation.r);
        
        vec4 diffuseColor = vec4( mix(uBaseColor,tipColor,vUv.y), step(0.1,grassAlpha.r) );

        // Warm key + cool fill. Blades are near-vertical so NdotL reads badly on
        // them; the base->tip gradient stands in for it and doubles as cheap AO.
        vec3 grassKey = uGrassLightColor * uGrassLightIntensity;
        float tipLift = mix(0.55, 1.0, vUv.y);
        vec3 grassFinalColor = diffuseColor.rgb * (uGrassAmbientColor + grassKey * tipLift);

        // light calculation derived from <lights_fragment_begin>
        vec3 geometryPosition = vViewPosition;
        vec3 geometryNormal = vNormal;
        vec3 geometryViewDir = ( isOrthographic ) ? vec3( 0, 0, 1 ) : normalize( vViewPosition );
        vec3 geometryClearcoatNormal;
          IncidentLight directLight;
          float shadow = 1.0;
          float currentShadow = 0.0;
          float NdotL;
          if(uEnableShadows == 1){
            #if ( NUM_DIR_LIGHTS > 0) 
              DirectionalLight directionalLight;
            #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
              DirectionalLightShadow directionalLightShadow;
              shadow = 0.0;
            #endif
              #pragma unroll_loop_start
              for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
                directionalLight = directionalLights[ i ];
                getDirectionalLightInfo( directionalLight, directLight );
            #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
                directionalLightShadow = directionalLightShadows[ i ];
                currentShadow = getShadow( directionalShadowMap[ i ], 
                  directionalLightShadow.shadowMapSize, 
                  directionalLightShadow.shadowBias, 
                  directionalLightShadow.shadowRadius, 
                  vDirectionalShadowCoord[ i ] );
                currentShadow = all( bvec2( directLight.visible, receiveShadow ) ) ? currentShadow : 1.0;
                float weight = clamp( pow( length( vDirectionalShadowCoord[ i ].xy * 2. - 1. ), 4. ), .0, 1. );

                shadow += mix( currentShadow, 1., weight);
            #endif
              }
              #pragma unroll_loop_end
            #endif
            // Luminance-normalise the tint so it rotates hue instead of also
            // darkening — uShadowDarkness alone owns how dark shadows get.
            vec3 shadowTint = uGrassShadowTint /
              max(dot(uGrassShadowTint, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
            shadowTint = mix(vec3(1.0), shadowTint, 0.6);
            grassFinalColor = mix(
              grassFinalColor,
              grassFinalColor * uShadowDarkness * shadowTint,
              1. - shadow
            );
          } else{
            grassFinalColor = grassFinalColor ;
          }

        // Car headlights (SpotLights) — soft contribution so grass doesn't blow out
        #if ( NUM_SPOT_LIGHTS > 0 )
          SpotLight spotLight;
          #pragma unroll_loop_start
          for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
            spotLight = spotLights[ i ];
            getSpotLightInfo( spotLight, geometryPosition, directLight );
            NdotL = saturate( abs( dot( geometryNormal, directLight.direction ) ) );
            grassFinalColor += diffuseColor.rgb * directLight.color * NdotL * 0.28;
          }
          #pragma unroll_loop_end
        #endif

        // Keep alpha for cutout; don't multiply RGB by shadow again (breaks night when no shadow maps).
        #include <alphatest_fragment>
        gl_FragColor = vec4(grassFinalColor ,1.0);

        // uncomment to visualize wind
        // vec3 windColorViz = vec3((vWindColor.x+vWindColor.y)/2.);
        // gl_FragColor = vec4(windColorViz,1.0);
        
        #include <tonemapping_fragment>
        #include <colorspace_fragment>

        // FOG
        #include <fog_fragment>
        // FOG

      }
      
    `;
		};
	}

	setupTextures(grassAlphaTexture: THREE.Texture, noiseTexture: THREE.Texture) {
		this.uniforms.grassAlphaTexture.value = grassAlphaTexture;
		this.uniforms.noiseTexture.value = noiseTexture;
	}

	setTerrainSize(size: number) {
		this.uniforms.uTerrainSize.value = size;
	}

	setupGUI(gui: GUI) {
		const folder = gui.addFolder("Grass");
		folder.addColor(this.grassColorProps, "baseColor").name("Base").onChange((value) => {
			this.uniforms.baseColor.value.set(value);
		});
		folder.addColor(this.grassColorProps, "tipColor1").name("Tip A").onChange((value) => {
			this.uniforms.tipColor1.value.set(value);
		});
		folder.addColor(this.grassColorProps, "tipColor2").name("Tip B").onChange((value) => {
			this.uniforms.tipColor2.value.set(value);
		});
		folder.add(this.uniforms.uNoiseScale, "value", 0, 5).name("Noise");
		folder
			.add(this.uniforms.uGrassLightIntensity, "value", 0, 2)
			.name("Light");
		folder
			.add(this.uniforms.uShadowDarkness, "value", 0, 1)
			.name("Shadow");
		folder.add(this.uniforms.uEnableShadows, "value").name("Shadows");

		folder.open();
	}
}

// ************** USAGE **************
/*
import { GrassMaterial } from "./GrassMaterial";

// in your main class
const grassMaterial: GrassMaterial;
// in your setup function
grassMaterial = new GrassMaterial();
// after loading the textures
grassMaterial.setupTextures(this.textures.grassAlpha, this.textures.perlinNoise);
// in your render function
uTime += this.clock.getDelta();
grassMaterial.update(uTime);

*/
