import React, { useEffect, useState, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useGLTF } from '@react-three/drei';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler';

import { createLargeTerrain, TERRAIN_CONFIG } from '../../terrain/createLargeTerrain';
import { setIslandTerrain } from '../../terrain/islandHeight';
import { createTerrainHeightfieldCollider } from '../../physics/terrainCollider';
import { GrassMaterial } from '../../GrassMaterial';
import { createTrees, type TreeHandle } from '../../entities/tree';
import { useGameStore } from '../../store/gameStore';
import { Environment } from './Environment';
import { Car } from './Car';
import { Human } from './Human';
import { RemotePlayers } from './RemotePlayers';

export function GameScene() {
  const { scene } = useThree();
  const [terrainMesh, setTerrainMesh] = useState<THREE.Mesh | null>(null);
  const [trees, setTrees] = useState<TreeHandle[]>([]);
  const grassGltf = useGLTF('/grassLODs.glb');

  useEffect(() => {
    // 1. Create Terrain
    const terrainMat = new THREE.MeshPhongMaterial({
      color: "#5e875e",
      shininess: 0,
      flatShading: true,
    });
    
    const { mesh, heights, nrows, ncols } = createLargeTerrain(terrainMat);
    scene.add(mesh);
    mesh.updateMatrixWorld(true);
    setIslandTerrain(mesh);
    createTerrainHeightfieldCollider(heights, nrows, ncols);
    setTerrainMesh(mesh);

    // 2. Create Trees
    const treeEntries = [];
    // Just a few trees for now
    for(let i=0; i<30; i++) {
       const a = Math.random() * Math.PI * 2;
       const r = 20 + Math.random() * 50;
       treeEntries.push({
           x0: Math.cos(a) * r,
           y0: 0,
           z0: Math.sin(a) * r,
           scale: 1 + Math.random(),
           rotationY: Math.random() * Math.PI * 2,
           leafColor: "#ffffff",
           leafLayers: 1,
           placeOnTerrain: true
       });
    }

    let mounted = true;
    createTrees(treeEntries).then(loadedTrees => {
        if (!mounted) return;
        loadedTrees.forEach(t => scene.add(t.group));
        setTrees(loadedTrees);
    });

    // Cleanup
    return () => {
      mounted = false;
      scene.remove(mesh);
      trees.forEach(t => {
          scene.remove(t.group);
          t.dispose();
      });
    };
  }, [scene]);

  useEffect(() => {
    // 3. Create Grass
    if (!terrainMesh || !grassGltf) return;

    let grassGeom = new THREE.BufferGeometry();
    grassGltf.scene.traverse((child) => {
      if (child instanceof THREE.Mesh && child.name.includes("LOD00")) {
        child.geometry.scale(5, 5, 5);
        grassGeom = child.geometry;
      }
    });

    const grassMat = new GrassMaterial();
    const grassCount = 30000;
    
    const sampler = new MeshSurfaceSampler(terrainMesh).build();
    const grassInstancedMesh = new THREE.InstancedMesh(grassGeom, grassMat.material, grassCount);
    grassInstancedMesh.receiveShadow = true;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const normal = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const matrix = new THREE.Matrix4();

    for (let i = 0; i < grassCount; i++) {
      sampler.sample(position, normal);
      quaternion.setFromUnitVectors(yAxis, normal);
      const randomRot = new THREE.Euler(0, Math.random() * Math.PI * 2, 0);
      quaternion.multiply(new THREE.Quaternion().setFromEuler(randomRot));
      matrix.compose(position, quaternion, scale);
      grassInstancedMesh.setMatrixAt(i, matrix);
    }
    
    grassInstancedMesh.instanceMatrix.needsUpdate = true;
    grassInstancedMesh.frustumCulled = false;
    scene.add(grassInstancedMesh);

    return () => {
      scene.remove(grassInstancedMesh);
    };
  }, [terrainMesh, grassGltf, scene]);

  return (
    <>
      <Environment />
      <Car />
      <Human />
      <RemotePlayers />
    </>
  );
}
