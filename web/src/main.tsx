import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Kiosk } from './pages/Kiosk';
import { Remote } from './pages/Remote';

const isRemote = window.location.pathname.replace(/\/+$/, '').endsWith('/remote');

createRoot(document.getElementById('root')!).render(<StrictMode>{isRemote ? <Remote /> : <Kiosk />}</StrictMode>);
