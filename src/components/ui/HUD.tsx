import React from 'react';
import { useGameStore } from '../../store/gameStore';

export function HUD() {
  const { appState, logout } = useGameStore();

  if (appState !== 'inGame') return null;

  return (
    <div id="game-top-nav" className="game-top-nav" style={{ display: 'flex' }}>
      <button 
        className="game-nav-btn logout-btn-style" 
        onClick={() => {
          localStorage.removeItem('cargame_token');
          logout();
        }}
      >
        Logout
      </button>
      <div className="controls-hint" style={{ position: 'fixed', bottom: '20px', width: '100%', textAlign: 'center', color: 'white', pointerEvents: 'none' }}>
        <p>WASD drive · Space brake · R reset · Drag orbit · Scroll zoom</p>
      </div>
    </div>
  );
}
