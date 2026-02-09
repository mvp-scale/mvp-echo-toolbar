import React from 'react';
import ReactDOM from 'react-dom/client';
import PopupApp from './PopupApp';
import './styles/globals.css';

console.log('MVP-Echo Toolbar: Popup window starting...');

const rootElement = document.getElementById('popup-root');
if (!rootElement) {
  throw new Error('Popup root element not found');
}

// In browser (no Electron), wrap in a fixed-size container matching the real popup window
const isElectron = typeof (window as any).electronAPI !== 'undefined' &&
  navigator.userAgent.toLowerCase().includes('electron');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {isElectron ? (
      <PopupApp />
    ) : (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        background: '#0a0a0b',
      }}>
        <div style={{ width: 380, height: 300, borderRadius: 8, overflow: 'hidden', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}>
          <PopupApp />
        </div>
      </div>
    )}
  </React.StrictMode>
);
