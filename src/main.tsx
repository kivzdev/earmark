import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles/tokens.css'
import './styles/site.css'
import './styles/app.css'
import { Shell } from './Shell'

// No StrictMode: its double-mounted effects would build GSAP timelines twice.
createRoot(document.getElementById('root')!).render(<Shell />)
