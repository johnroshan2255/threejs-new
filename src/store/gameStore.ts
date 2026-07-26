import { create } from 'zustand';
import type { Socket } from 'socket.io-client';

export type AppState = 'loading' | 'auth' | 'mainMenu' | 'lobby' | 'roomList' | 'inGame';
export type ActiveEntity = 'car' | 'human';

interface PlayerData {
  socketId: string;
  user: {
    username: string;
    id: string;
  };
}

interface GameState {
  appState: AppState;
  username: string | null;
  token: string | null;
  roomCode: string | null;
  isHost: boolean;
  players: PlayerData[];
  activeEntity: ActiveEntity;
  socket: Socket | null;
  
  // Actions
  setAppState: (state: AppState) => void;
  setAuth: (username: string, token: string) => void;
  logout: () => void;
  setRoom: (roomCode: string, isHost: boolean) => void;
  updatePlayers: (players: PlayerData[]) => void;
  setActiveEntity: (entity: ActiveEntity) => void;
  setSocket: (socket: Socket) => void;
}

export const useGameStore = create<GameState>((set) => ({
  appState: 'loading',
  username: null,
  token: null,
  roomCode: null,
  isHost: false,
  players: [],
  activeEntity: 'car',
  socket: null,

  setAppState: (state) => set({ appState: state }),
  setAuth: (username, token) => set({ username, token, appState: 'mainMenu' }),
  logout: () => set({ username: null, token: null, appState: 'auth', roomCode: null, players: [] }),
  setRoom: (roomCode, isHost) => set({ roomCode, isHost, appState: 'lobby' }),
  updatePlayers: (players) => set({ players }),
  setActiveEntity: (activeEntity) => set({ activeEntity }),
  setSocket: (socket) => set({ socket }),
}));
