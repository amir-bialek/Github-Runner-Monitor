// First: installs the Debug it fixture API before services/api.ts creates its axios instances.
import './fixtureApi';
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../queryClient';
import PreviewApp from './PreviewApp';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    {/* Debug it requests are answered by the fixture API; nothing reaches a backend. */}
    <QueryClientProvider client={createQueryClient()}>
      <PreviewApp />
    </QueryClientProvider>
  </React.StrictMode>
);
