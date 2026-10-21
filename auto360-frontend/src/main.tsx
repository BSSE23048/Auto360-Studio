import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ConnectionNotice from './ConnectionNotice';
import './styles.css';
import './cloud.css';
import './production.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ConnectionNotice/><App /></React.StrictMode>,
);
