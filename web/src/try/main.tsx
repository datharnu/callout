import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/chrome.css'
import '../styles/try.css'
import { Try } from './Try'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Try />
  </StrictMode>,
)
