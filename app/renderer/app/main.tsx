import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { initializeBrowserMocks } from '../browser-mock';

// Initialize browser mocks if not in Electron
initializeBrowserMocks();

console.log('MVP-Echo: Starting React application...');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

console.log('MVP-Echo: Root element found, creating React root...');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);