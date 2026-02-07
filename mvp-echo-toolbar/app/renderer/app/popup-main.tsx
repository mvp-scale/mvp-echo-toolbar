import React from 'react';
import ReactDOM from 'react-dom/client';
import PopupApp from './PopupApp';
import './styles/globals.css';

console.log('MVP-Echo Toolbar: Popup window starting...');

const rootElement = document.getElementById('popup-root');
if (!rootElement) {
  throw new Error('Popup root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);
