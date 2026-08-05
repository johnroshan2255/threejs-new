const fs = require('fs');

const css = `
/* =========================================
   CUSTOM SETTINGS MODAL
   ========================================= */

.custom-settings-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 8, 6, 0.7);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  opacity: 1;
  transition: opacity 0.3s ease;
}

.custom-settings-overlay.hidden {
  opacity: 0;
  pointer-events: none;
}

.custom-settings-modal {
  width: 90%;
  max-width: 800px;
  background: rgba(18, 26, 20, 0.85);
  border: 1px solid rgba(163, 217, 119, 0.2);
  border-radius: 24px;
  box-shadow: 0 24px 50px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #eaf6df;
  font-family: "Sora", sans-serif;
  max-height: 90vh;
}

.custom-settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 30px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  background: linear-gradient(180deg, rgba(255,255,255,0.05) 0%, transparent 100%);
}

.custom-settings-header h2 {
  margin: 0;
  font-size: 1.6rem;
  letter-spacing: 0.1em;
  font-weight: 700;
  text-transform: uppercase;
  background: linear-gradient(135deg, #fff, #a3d977);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.custom-settings-close {
  background: transparent !important;
  border: none !important;
  color: rgba(255,255,255,0.5) !important;
  font-size: 2rem;
  cursor: pointer;
  line-height: 1;
  box-shadow: none !important;
}
.custom-settings-close:hover {
  color: #fff !important;
  transform: scale(1.1) !important;
}

.custom-settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.custom-settings-sidebar {
  width: 220px;
  background: rgba(0,0,0,0.2);
  border-right: 1px solid rgba(255,255,255,0.05);
  display: flex;
  flex-direction: column;
  padding: 20px 0;
}

.custom-settings-sidebar button {
  background: transparent !important;
  border: none !important;
  color: rgba(255,255,255,0.6) !important;
  padding: 15px 30px;
  text-align: left;
  font-size: 0.9rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  cursor: pointer;
  box-shadow: none !important;
  border-radius: 0 !important;
  transition: all 0.2s ease !important;
}

.custom-settings-sidebar button:hover {
  color: #fff !important;
  background: rgba(255,255,255,0.05) !important;
}

.custom-settings-sidebar button.active {
  color: #a3d977 !important;
  background: rgba(163, 217, 119, 0.1) !important;
  border-left: 3px solid #a3d977 !important;
}

.custom-settings-content {
  flex: 1;
  padding: 30px;
  overflow-y: auto;
}

.settings-pane {
  display: none;
  animation: fade-in 0.3s ease;
}

.settings-pane.active {
  display: block;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}

.settings-pane h3 {
  margin-top: 0;
  margin-bottom: 25px;
  font-size: 1.1rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: rgba(255,255,255,0.9);
  text-transform: uppercase;
}

.setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-row label {
  font-size: 0.95rem;
  color: rgba(255,255,255,0.7);
  font-weight: 500;
}

/* Custom Controls */
.setting-row select {
  background: rgba(0,0,0,0.3) !important;
  border: 1px solid rgba(255,255,255,0.1) !important;
  color: #fff !important;
  padding: 10px 15px !important;
  border-radius: 8px !important;
  font-family: inherit;
  font-size: 0.9rem;
  min-width: 150px;
  cursor: pointer;
  outline: none;
}
.setting-row select:focus {
  border-color: #a3d977 !important;
}

.slider-container {
  display: flex;
  align-items: center;
  gap: 15px;
  width: 50%;
  min-width: 200px;
}

.slider-container input[type="range"] {
  flex: 1;
  -webkit-appearance: none;
  height: 6px;
  background: rgba(255,255,255,0.1);
  border-radius: 5px;
  outline: none;
}

.slider-container input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #a3d977;
  cursor: pointer;
  box-shadow: 0 0 10px rgba(163, 217, 119, 0.5);
  transition: transform 0.1s;
}

.slider-container input[type="range"]::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.slider-value {
  font-size: 0.9rem;
  color: #fff;
  min-width: 40px;
  text-align: right;
  font-weight: 600;
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 50px;
  height: 26px;
}
.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255,255,255,0.1);
  transition: .4s;
  border-radius: 26px;
  border: 1px solid rgba(255,255,255,0.1);
}
.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .4s;
  border-radius: 50%;
}
input:checked + .toggle-slider {
  background-color: #a3d977;
  border-color: #a3d977;
  box-shadow: 0 0 10px rgba(163, 217, 119, 0.3);
}
input:checked + .toggle-slider:before {
  transform: translateX(24px);
  background-color: #0e1410;
}

/* Responsive Modal */
@media (max-width: 768px) {
  .custom-settings-body {
    flex-direction: column;
  }
  .custom-settings-sidebar {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid rgba(255,255,255,0.05);
    padding: 0;
  }
  .custom-settings-sidebar button {
    padding: 15px 20px;
    white-space: nowrap;
    border-left: none !important;
    border-bottom: 3px solid transparent !important;
  }
  .custom-settings-sidebar button.active {
    border-bottom: 3px solid #a3d977 !important;
  }
  .slider-container {
    width: 100%;
    min-width: 100%;
    margin-top: 10px;
  }
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
}
`;

fs.appendFileSync('src/style.css', css, 'utf8');
console.log('Appended custom settings UI styles.');
