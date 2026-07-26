import React, { useEffect, useState, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { HumanEntity } from '../../entities/human/HumanEntity';
import { HumanInput } from '../../entities/human/HumanInput';
import { useGameStore } from '../../store/gameStore';

export function Human() {
  const { scene, camera } = useThree();
  const { activeEntity, setActiveEntity, socket, roomCode } = useGameStore();
  const [humanSystem, setHumanSystem] = useState<{
    human: HumanEntity,
    input: HumanInput
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    const human = new HumanEntity();
    human.load().then(() => {
      if (!mounted) return;
      scene.add(human.mesh);
      
      const input = new HumanInput(human, camera as any, setActiveEntity);
      setHumanSystem({ human, input });
    });

    return () => {
      mounted = false;
      if (humanSystem) {
        scene.remove(humanSystem.human.mesh);
      }
    };
  }, [scene, camera, setActiveEntity]);

  const frameCount = useRef(0);

  useFrame((state, delta) => {
    if (humanSystem && activeEntity === 'human') {
      humanSystem.input.update(delta);
      
      if (humanSystem.human.mesh.visible) {
         humanSystem.human.update(delta); // Animation mixer
      }

      // Network Sync
      frameCount.current++;
      if (frameCount.current % 10 === 0 && socket && roomCode) {
        const p = humanSystem.human.mesh.position;
        const q = humanSystem.human.mesh.quaternion;
        
        socket.emit("player-state", {
          roomCode,
          state: {
            activeEntity: "human",
            position: { x: p.x, y: p.y, z: p.z },
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w },
            animation: humanSystem.human.currentAction?.getClip().name || "Idle"
          }
        });
      }
    }
  });

  return null;
}
