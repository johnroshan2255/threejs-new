import React, { useEffect, useState } from 'react';
import { useGameStore } from '../../store/gameStore';

export function Lobby() {
  const { appState, roomCode, players, isHost, setAppState, socket } = useGameStore();
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (appState === 'lobby' && socket && roomCode) {
      if (isHost) {
        socket.emit("create-room", { username: useGameStore.getState().username, id: 'host-id' }, (res: any) => {
          if (res.success) {
            useGameStore.getState().setRoom(res.roomCode, true);
          }
        });
      } else {
        socket.emit("join-room", { roomCode, userData: { username: useGameStore.getState().username, id: 'client-id' } }, (res: any) => {
          if (!res.success) {
            setErrorMsg(res.error || 'Failed to join room');
            setTimeout(() => setAppState('mainMenu'), 2000);
          }
        });
      }

      socket.on("room-updated", (updatedPlayers: any[]) => {
        useGameStore.getState().updatePlayers(updatedPlayers);
      });

      socket.on("game-started", () => {
        setAppState('inGame');
      });

      return () => {
        socket.off("room-updated");
        socket.off("game-started");
      };
    }
  }, [appState, socket, roomCode, isHost, setAppState]);

  if (appState !== 'lobby') return null;

  const handleStartGame = () => {
    if (socket && roomCode) {
      socket.emit("start-game", roomCode);
    }
  };

  const handleLeave = () => {
    setAppState('mainMenu');
    useGameStore.getState().setRoom(null, false);
    useGameStore.getState().updatePlayers([]);
    // Optionally emit leave-room to server here
  };

  return (
    <div className="lobby-panel" style={{ display: 'block' }}>
      <div className="lobby-content">
        <h2>Multiplayer Lobby {roomCode ? `(${roomCode})` : ''}</h2>
        {errorMsg && <p style={{ color: '#e3a35b' }}>{errorMsg}</p>}
        
        <div className="player-grid">
          {[0, 1, 2, 3].map(i => {
            const player = players[i];
            return (
              <div key={i} className="player-slot">
                <div className={`slot-content ${!player ? 'empty' : ''}`}>
                  {player ? player.user.username : 'Waiting...'}
                </div>
              </div>
            );
          })}
        </div>

        <div className="lobby-buttons">
          {isHost && (
            <button 
              className="start-game-btn" 
              onClick={handleStartGame}
              disabled={players.length < 2}
              style={{ display: 'block', background: players.length >= 2 ? 'linear-gradient(135deg, #a3d977, #77d9c4)' : '#555' }}
            >
              {players.length < 2 ? 'Waiting for players...' : 'Start Game'}
            </button>
          )}
          <button className="leave-lobby-btn" onClick={handleLeave}>Leave Room</button>
        </div>
      </div>
    </div>
  );
}
