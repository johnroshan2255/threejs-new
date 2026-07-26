import React, { useEffect, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { initPhysics, getWorld } from '../../physics/world';

export function PhysicsManager({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    initPhysics().then(() => {
      setReady(true);
    });
  }, []);

  useFrame((state, delta) => {
    if (!ready) return;
    const world = getWorld();
    
    // Cap delta time to prevent physics explosions on lag spikes
    const dt = Math.min(delta, 0.1);
    world.timestep = dt;
    world.step();
  });

  if (!ready) return null;

  return <>{children}</>;
}
