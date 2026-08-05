const fs = require('fs');
const css = `
/* =========================================
   MODERN PREMIUM RESPONSIVE UI OVERRIDES
   ========================================= */

/* --- 1. Global Premium Aesthetics --- */
button, input[type="range"], input[type="text"], input[type="email"], select {
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1) !important;
}
button:active:not(:disabled) {
  transform: scale(0.96) !important;
}

/* Glassmorphism improvements */
.lobby-panel, .logout-modal-content, .world-loading-overlay, .world-loading-card {
  background: rgba(14, 22, 16, 0.65) !important;
  backdrop-filter: blur(24px) saturate(1.4) !important;
  -webkit-backdrop-filter: blur(24px) saturate(1.4) !important;
  border: 1px solid rgba(163, 217, 119, 0.2) !important;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1) !important;
  border-radius: 20px !important;
}

.start-game-btn, .submit-btn, .confirm-btn, .play-button {
  background: linear-gradient(135deg, #a3d977, #77d9c4) !important;
  color: #0e1410 !important;
  border: none !important;
  box-shadow: 0 4px 15px rgba(163, 217, 119, 0.3) !important;
}
.start-game-btn:hover:not(:disabled), .submit-btn:hover:not(:disabled), .confirm-btn:hover:not(:disabled), .play-button:hover:not(:disabled) {
  box-shadow: 0 6px 20px rgba(163, 217, 119, 0.5) !important;
  transform: translateY(-2px) !important;
  opacity: 1 !important;
}

/* --- 2. Loading & Login Screens --- */
.loading-screen {
  flex-direction: row;
  justify-content: center;
  align-items: center;
  /* Premium backdrop */
  background: radial-gradient(circle at center, rgba(14, 22, 16, 0.8) 0%, rgba(5, 8, 5, 0.95) 100%) !important;
}

@media (max-width: 768px) {
  .loading-screen {
    flex-direction: column;
    padding: 20px;
    overflow-y: auto;
  }
  .loading-panel {
    width: 100% !important;
    max-width: 400px;
    margin-bottom: 20px;
  }
  .account-panel {
    border-left: none !important;
    border-top: 1px solid rgba(163, 217, 119, 0.3);
    width: 100% !important;
    height: auto !important;
  }
  .account-panel-content {
    padding: 2rem 1rem !important;
    width: 100%;
  }
  .create-account-btn {
    margin: 10px auto !important;
    display: block;
    width: 100%;
    max-width: 300px;
  }
  .loading-content h1 {
    font-size: 2rem !important;
  }
  /* Modals */
  .logout-modal-content {
    width: 90% !important;
    padding: 1.5rem !important;
    margin: 0 auto;
  }
}

/* Button touch targets for mobile */
button {
  min-height: 44px;
}

/* --- 3. Multiplayer Top Nav --- */
#game-top-nav {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  padding: 15px;
  position: fixed;
  top: 0;
  right: 0;
  z-index: 10000;
}
@media (max-width: 600px) {
  #game-top-nav {
    justify-content: center;
    width: 100%;
    background: linear-gradient(180deg, rgba(0,0,0,0.6) 0%, transparent 100%);
    padding-top: 15px;
  }
  .game-nav-btn {
    font-size: 0.85rem !important;
    padding: 8px 16px !important;
    flex: 1 1 auto;
    text-align: center;
  }
}

/* --- 4. Settings Panel (dat.gui) --- */
@media (max-width: 640px) {
  .dg.main {
    width: calc(100vw - 32px) !important;
    margin: 70px 16px 16px !important;
    max-height: calc(100vh - 100px) !important;
  }
  .dg li.title {
    font-size: 13px !important;
    padding: 14px 12px !important;
  }
  .dg .property-name {
    font-size: 14px !important;
  }
  .dg .c select, .dg .c input[type="text"] {
    font-size: 14px !important;
    padding: 8px !important;
    min-height: 36px;
  }
  /* Bigger sliders for touch */
  .dg .c .slider {
    height: 12px !important;
    margin-top: 12px !important;
  }
  .dg .c .slider-fg {
    height: 12px !important;
  }
}

/* --- 5. Editor UI --- */
.edit-top-bar {
  background: rgba(14, 22, 16, 0.75) !important;
  backdrop-filter: blur(20px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.2) !important;
  border-bottom: 1px solid rgba(163, 217, 119, 0.15) !important;
  box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;
}

.edit-left-bar {
  background: rgba(14, 22, 16, 0.75) !important;
  backdrop-filter: blur(20px) saturate(1.2) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.2) !important;
  border-right: 1px solid rgba(163, 217, 119, 0.15) !important;
  box-shadow: 4px 0 20px rgba(0,0,0,0.2) !important;
}

/* Make edit mesh grid responsive */
.edit-mesh-grid {
  display: grid !important;
  grid-template-columns: repeat(auto-fill, minmax(70px, 1fr)) !important;
  gap: 12px !important;
  padding: 10px !important;
}
.edit-mesh-thumb {
  width: 100% !important;
  height: auto !important;
  aspect-ratio: 1;
  background: rgba(255,255,255,0.05) !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  border-radius: 12px !important;
  overflow: hidden;
}
.edit-mesh-thumb:hover, .edit-mesh-thumb.is-active {
  border-color: #a3d977 !important;
  background: rgba(163, 217, 119, 0.15) !important;
}
.edit-mesh-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.edit-mesh-thumb span {
  display: none !important; /* hide text on thumbnails, use tooltip/title */
}

@media (max-width: 800px) {
  /* Bottom bar instead of top for easier thumb reach */
  .edit-top-bar {
    top: auto !important;
    bottom: 0 !important;
    border-bottom: none !important;
    border-top: 1px solid rgba(163, 217, 119, 0.15) !important;
  }
  .edit-top-scroll {
    overflow-x: auto;
    padding: 10px;
    flex-wrap: nowrap !important;
  }
  .edit-top-options, .edit-top-actions {
    flex-shrink: 0;
  }
  /* Left bar becomes a floating bottom-left palette or right-side sheet */
  .edit-left-bar {
    top: auto !important;
    bottom: 70px !important;
    left: 10px !important;
    right: 10px !important;
    width: auto !important;
    height: 250px !important;
    border-radius: 16px !important;
    border: 1px solid rgba(163, 217, 119, 0.2) !important;
    flex-direction: column !important;
    display: none !important;
  }
  .edit-left-bar.is-open {
    display: flex !important;
  }
  .edit-tools-rail {
    flex-direction: row !important;
    width: 100% !important;
    height: auto !important;
    overflow-x: auto !important;
    border-right: none !important;
    border-bottom: 1px solid rgba(255,255,255,0.1) !important;
  }
  .edit-tools-scroll {
    display: flex !important;
    flex-direction: row !important;
    gap: 8px !important;
  }
  .edit-asset {
    min-width: 60px;
    padding: 8px !important;
    text-align: center;
  }
  .edit-asset span {
    font-size: 11px !important;
  }
}
`;

fs.appendFileSync('src/style.css', css, 'utf8');
console.log('Appended premium responsive UI styles.');
