import React from 'react';
import ReactDOM from 'react-dom/client';
import CaptureApp from './CaptureApp';

console.log('MVP-Echo Toolbar: Hidden capture window starting...');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <CaptureApp />
  </React.StrictMode>
);
