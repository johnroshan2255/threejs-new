import React, { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { useGameStore } from './store/gameStore';
import { io } from 'socket.io-client';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3000";

import { LoadingScreen } from './components/ui/LoadingScreen';
import { Lobby } from './components/ui/Lobby';
import { GameScene } from './components/3d/GameScene';
import { HUD } from './components/ui/HUD';
import { PhysicsManager } from './components/3d/PhysicsManager';

export function App() {
  const { appState, setSocket } = useGameStore();

  useEffect(() => {
    const newSocket = io(SERVER_URL);
    setSocket(newSocket);
    return () => { newSocket.disconnect(); };
  }, [setSocket]);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {/* 3D Scene */}
      <Canvas shadows camera={{ position: [0, 5, 10], fov: 60 }}>
        {appState === 'inGame' && (
          <PhysicsManager>
            <GameScene />
          </PhysicsManager>
        )}
      </Canvas>

      {/* 2D UI Layer */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div style={{ pointerEvents: 'auto', width: '100%', height: '100%' }}>
          <LoadingScreen />
          <Lobby />
          <HUD />
        </div>
      </div>
    </div>
  );
}
