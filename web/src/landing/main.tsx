import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles/base.css'
import '../styles/chrome.css'
import '../styles/landing.css'
import { Landing } from './Landing'
import { prewarm } from '../lib/api'

// Start waking the (free-tier) backend while the visitor reads, so /try is usually instant.
prewarm()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
)
