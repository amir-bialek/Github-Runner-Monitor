import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import PreviewApp from './PreviewApp';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <PreviewApp />
  </React.StrictMode>
);
