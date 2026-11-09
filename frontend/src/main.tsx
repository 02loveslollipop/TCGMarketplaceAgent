import React from 'react';
import ReactDOM from 'react-dom/client';
import '@cloudscape-design/global-styles/index.css';
import './dark-blue.css';
import {initializeAppearance} from './appearance';
import {Shell} from './Shell';
initializeAppearance();
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Shell/></React.StrictMode>);
