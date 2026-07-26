import React, { useState, useEffect } from 'react';
import { useGameStore } from '../../store/gameStore';
import { api } from '../../services/api';

export function LoadingScreen() {
  const { appState, setAppState, setAuth } = useGameStore();
  const [activePanel, setActivePanel] = useState<'main' | 'login' | 'account' | 'join'>('main');
  const [loadingText, setLoadingText] = useState('Checking authentication...');
  
  // Form states
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('cargame_token');
    if (token) {
      api.validateToken(token).then(data => {
        if (data.success && data.user) {
          setAuth(data.user.username, token);
        } else {
          localStorage.removeItem('cargame_token');
          setAppState('auth');
        }
      }).catch(() => {
        localStorage.removeItem('cargame_token');
        setAppState('auth');
      });
    } else {
      setAppState('auth');
    }
  }, [setAppState, setAuth]);

  const handleCreateAccount = async () => {
    if (!username || !email) {
      setErrorMsg('Please enter username and email');
      return;
    }
    setErrorMsg('');
    try {
      const data = await api.register(username, email);
      if (data.success) {
        setSuccessMsg('Account created!');
        setTimeout(() => setActivePanel('login'), 1500);
      } else {
        setErrorMsg(data.error || 'Failed to create account');
      }
    } catch (err) {
      setErrorMsg('Network error');
    }
  };

  const handleLogin = async () => {
    if (!email) {
      setErrorMsg('Please enter email');
      return;
    }
    setErrorMsg('');
    try {
      const data = await api.login(email);
      if (data.success) {
        localStorage.setItem('cargame_token', data.token);
        setAuth(data.user.username, data.token);
      } else {
        setErrorMsg(data.error || 'Login failed');
      }
    } catch (err) {
      setErrorMsg('Network error');
    }
  };

  if (appState !== 'loading' && appState !== 'auth' && appState !== 'mainMenu') {
    return null; // Don't render loading screen if in game or lobby
  }

  const wrapperClass = `loading-screen ${activePanel === 'account' ? 'show-account' : activePanel === 'login' || activePanel === 'join' ? 'show-login' : ''}`;

  return (
    <div className={wrapperClass}>
      <div className="loading-panel">
        <div className="loading-content">
          <h1>The Car Game</h1>
          
          {appState === 'loading' ? (
            <>
              <div className="loading-bar-container">
                <div className="loading-bar" style={{ width: '100%' }}></div>
              </div>
              <p>{loadingText}</p>
            </>
          ) : (
            <div className="main-action-buttons" style={{ display: 'flex', gap: '12px', justifyContent: 'center', alignItems: 'stretch', marginBottom: '15px', flexDirection: 'column', width: '250px', marginLeft: 'auto', marginRight: 'auto' }}>
              <button className="play-button ready" onClick={() => setAppState('inGame')}>Play Offline</button>
              
              {appState === 'mainMenu' ? (
                <>
                  <button className="play-button host-btn ready" style={{ background: 'linear-gradient(135deg, #e3a35b, #d97777)' }} onClick={() => useGameStore.getState().setRoom('NEW', true)}>Host Game</button>
                  <button className="play-button join-btn ready" style={{ background: 'linear-gradient(135deg, #5ba3e3, #77d9c4)' }} onClick={() => setActivePanel('join')}>Join Game</button>
                </>
              ) : (
                <button className="play-button ready" onClick={() => setActivePanel('login')}>Login to Play Online</button>
              )}
            </div>
          )}
        </div>
      </div>

      {appState === 'auth' && (
        <button className="create-account-btn" onClick={() => setActivePanel('account')}>Create Account</button>
      )}

      {/* Account Panel */}
      <div id="account-panel" className="account-panel">
        <div className="account-panel-content">
          <h2>Create Account</h2>
          <input type="text" placeholder="Username" value={username} onChange={e => setUsername(e.target.value)} />
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
          <div className="account-buttons">
            <button className="submit-btn" onClick={handleCreateAccount}>Submit</button>
            <button className="close-btn" onClick={() => { setActivePanel('main'); setErrorMsg(''); setSuccessMsg(''); }}>Cancel</button>
          </div>
          {errorMsg && <p style={{ color: '#e3a35b', marginTop: '10px' }}>{errorMsg}</p>}
          {successMsg && <p style={{ color: '#a3d977', marginTop: '10px' }}>{successMsg}</p>}
        </div>
      </div>

      {/* Login Panel */}
      <div id="login-panel" className="account-panel login-panel" style={{ display: activePanel === 'login' ? 'block' : 'none' }}>
        <div className="account-panel-content">
          <h2>Login to Play</h2>
          <input type="email" placeholder="Email Address" value={email} onChange={e => setEmail(e.target.value)} />
          <div className="account-buttons">
            <button className="submit-btn" onClick={handleLogin}>Login</button>
            <button className="close-btn" onClick={() => { setActivePanel('main'); setErrorMsg(''); }}>Cancel</button>
          </div>
          {errorMsg && <p style={{ color: '#e3a35b', marginTop: '10px' }}>{errorMsg}</p>}
        </div>
      </div>

      {/* Join Panel */}
      <div id="join-panel" className="account-panel login-panel" style={{ display: activePanel === 'join' ? 'block' : 'none' }}>
        <div className="account-panel-content">
          <h2>Join Game</h2>
          <input type="text" placeholder="Enter 5-Letter Room Code" style={{ textTransform: 'uppercase' }} maxLength={5} value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} />
          <div className="account-buttons">
            <button className="submit-btn" style={{ background: 'linear-gradient(135deg, #5ba3e3, #77d9c4)' }} onClick={() => useGameStore.getState().setRoom(joinCode, false)}>Join Room</button>
            <button className="close-btn" onClick={() => { setActivePanel('main'); setErrorMsg(''); }}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
