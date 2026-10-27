import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import BookPage from './BookPage.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BookPage />
  </StrictMode>,
);
