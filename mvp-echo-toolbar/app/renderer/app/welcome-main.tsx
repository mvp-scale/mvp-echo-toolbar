import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { WelcomeScreen } from './components/WelcomeScreen';
import './styles/globals.css';

const rootElement = document.getElementById('welcome-root');
if (!rootElement) {
  throw new Error('Welcome root element not found');
}

function handleDismiss() {
  try {
    (window as any).electronAPI.closeWelcome();
  } catch (_e) {
    window.close();
  }
}

function WelcomeApp() {
  const [version, setVersion] = useState('');

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.getAppVersion) {
      api.getAppVersion()
        .then((v: string) => setVersion(v))
        .catch(() => setVersion('3.0.0'));
    } else {
      setVersion('3.0.0');
    }
  }, []);

  if (!version) return null;

  return <WelcomeScreen onDismiss={handleDismiss} version={version} />;
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <WelcomeApp />
  </React.StrictMode>
);
