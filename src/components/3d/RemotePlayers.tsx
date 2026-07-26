import React, { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGameStore } from '../../store/gameStore';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { loadKenneySuvVisual } from '../../entities/car/kenneyCarVisual';

export function RemotePlayers() {
  const { scene } = useThree();
  const { socket, players } = useGameStore();
  const remoteData = useRef(new Map<string, any>());

  useEffect(() => {
    if (!socket) return;
    const loader = new GLTFLoader();

    socket.on("player-state", async (data: any) => {
      const { socketId, state } = data;
      if (socketId === socket.id) return; // Skip self

      let rp = remoteData.current.get(socketId);
      if (!rp) {
        rp = {
          loaded: false,
          humanGroup: new THREE.Group(),
          carGroup: new THREE.Group(),
          targetPosition: new THREE.Vector3(),
          targetQuaternion: new THREE.Quaternion(),
          animations: new Map(),
          mixer: null,
          currentAction: null,
        };
        remoteData.current.set(socketId, rp);

        // Load models asynchronously
        const [humanGltf, carLayout] = await Promise.all([
          loader.loadAsync('/stickman.glb'),
          loadKenneySuvVisual(0)
        ]);

        // Human setup
        const humanModel = humanGltf.scene;
        humanModel.scale.setScalar(0.01);
        humanModel.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
        rp.humanGroup.add(humanModel);
        
        rp.mixer = new THREE.AnimationMixer(humanModel);
        humanGltf.animations.forEach((clip: any) => {
          rp.animations.set(clip.name, rp.mixer.clipAction(clip));
        });

        // Car setup
        const carModel = carLayout.chassis;
        carModel.traverse((child) => { if (child instanceof THREE.Mesh) child.castShadow = true; });
        rp.carGroup.add(carModel);

        scene.add(rp.humanGroup);
        scene.add(rp.carGroup);
        rp.loaded = true;
      }

      if (!rp.loaded) return;

      // Apply network data
      rp.targetPosition.set(state.position.x, state.position.y, state.position.z);
      rp.targetQuaternion.set(state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w);
      
      if (state.activeEntity === "human") {
        rp.humanGroup.visible = true;
        rp.carGroup.visible = false;
        
        if (state.animation && rp.animations.has(state.animation)) {
          if (rp.currentAction !== rp.animations.get(state.animation)) {
            if (rp.currentAction) rp.currentAction.fadeOut(0.2);
            rp.currentAction = rp.animations.get(state.animation);
            rp.currentAction.reset().fadeIn(0.2).play();
          }
        }
      } else {
        rp.humanGroup.visible = false;
        rp.carGroup.visible = true;
      }
    });

    socket.on("user-disconnected", (socketId: string) => {
      const rp = remoteData.current.get(socketId);
      if (rp && rp.loaded) {
        scene.remove(rp.humanGroup);
        scene.remove(rp.carGroup);
      }
      remoteData.current.delete(socketId);
    });

    return () => {
      socket.off("player-state");
      socket.off("user-disconnected");
      remoteData.current.forEach(rp => {
        if (rp.loaded) {
          scene.remove(rp.humanGroup);
          scene.remove(rp.carGroup);
        }
      });
      remoteData.current.clear();
    };
  }, [socket, scene]);

  useFrame((state, delta) => {
    remoteData.current.forEach(rp => {
      if (!rp.loaded) return;
      
      const targetGroup = rp.humanGroup.visible ? rp.humanGroup : rp.carGroup;
      targetGroup.position.lerp(rp.targetPosition, 0.3);
      targetGroup.quaternion.slerp(rp.targetQuaternion, 0.3);

      if (rp.humanGroup.visible && rp.mixer) {
        rp.mixer.update(delta);
      }
    });
  });

  return null;
}
