import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiProvider } from './lib/api';
import './styles.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ApiProvider api={window.bgt}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
