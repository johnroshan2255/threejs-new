import React, { useEffect, useMemo, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { createDayNightCycle, type DayNightCycle } from '../../environment/dayNightCycle';
import { createFireflies, type Fireflies } from '../../environment/fireflies';

export function Environment() {
  const { scene, camera } = useThree();
  const [dayNight, setDayNight] = useState<DayNightCycle | null>(null);
  const [fireflies, setFireflies] = useState<Fireflies | null>(null);

  useEffect(() => {
    // Setup Day/Night
    const cycle = createDayNightCycle(scene);
    setDayNight(cycle);

    // Setup Fireflies
    const flies = createFireflies(scene, camera);
    setFireflies(flies);

    return () => {
      cycle.dispose();
      flies.dispose();
    };
  }, [scene, camera]);

  useFrame((state, delta) => {
    if (dayNight && fireflies) {
      const fireflyIntensity = dayNight.update(delta);
      const isDay = dayNight.hour > 6 && dayNight.hour < 18;
      const amount = isDay ? 0 : 1;
      
      // Update fireflies
      fireflies.update(
        delta,
        amount, 
        fireflyIntensity,
        state.camera.position,
        null, // No car forward vector for now
        false // No headlights for now
      );
    }
  });

  return null; // Both systems attach directly to the Three.js scene
}
