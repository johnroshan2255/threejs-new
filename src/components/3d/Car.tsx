import React, { useEffect, useState, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGameStore } from '../../store/gameStore';
import { createCar, type CarEntity } from '../../entities/car/createCar';
import { CarController } from '../../entities/car/carController';
import { CarInput } from '../../entities/car/carInput';
import { ChaseCameraInput } from '../../three/chaseCameraInput';
import { updateChaseCamera } from '../../three/chaseCamera';
import { CAR_CONFIG } from '../../entities/car/carConfig';

export function Car() {
  const { scene, camera } = useThree();
  const [carSystem, setCarSystem] = useState<{
    car: CarEntity,
    controller: CarController,
    input: CarInput,
    cameraInput: ChaseCameraInput
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    
    createCar().then(car => {
      if (!mounted) return;
      scene.add(car.mesh);
      const controller = new CarController(car, camera as any);
      const input = new CarInput(controller, camera as any);
      const cameraInput = new ChaseCameraInput(camera as any, car.mesh);
      
      setCarSystem({ car, controller, input, cameraInput });
    });

    return () => {
      mounted = false;
      // Cleanup: remove mesh, destroy rigid body
      if (carSystem) {
        scene.remove(carSystem.car.mesh);
        // Note: Ideally we'd remove the rigid body from the physics world here too
        // but world.removeRigidBody isn't currently tracked in createCar perfectly yet without world instance
      }
    };
  }, [scene, camera]);

  const frameCount = useRef(0);
  const { socket, roomCode, activeEntity } = useGameStore();

  useFrame((state, delta) => {
    if (carSystem && activeEntity === 'car') {
      // 1. Controller logic
      carSystem.controller.update(delta);
      
      // 2. Camera tracking
      carSystem.cameraInput.update(delta);
      
      // 3. Keep mesh in sync with rigid body
      const p = carSystem.car.body.translation();
      const q = carSystem.car.body.rotation();
      carSystem.car.mesh.position.set(p.x, p.y, p.z);
      carSystem.car.mesh.quaternion.set(q.x, q.y, q.z, q.w);

      // 4. Network Sync
      frameCount.current++;
      if (frameCount.current % 10 === 0 && socket && roomCode) {
        socket.emit("player-state", {
          roomCode,
          state: {
            activeEntity: "car",
            position: { x: p.x, y: p.y, z: p.z },
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w }
          }
        });
      }
    }
  });

  return null;
}
