import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './perf'
import './styles.css'
import { App } from './App'
import { Landing } from './landing/Landing'

const isLanding = location.pathname === '/'

createRoot(document.getElementById('root')!).render(<StrictMode>{isLanding ? <Landing /> : <App />}</StrictMode>)
