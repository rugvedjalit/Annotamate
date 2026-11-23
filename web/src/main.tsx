import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/index.css'
import { applyThemeClass, readStoredTheme, resolveTheme } from './lib/settings'
import { Providers } from './app/providers'
import { router } from './app/router'

// Apply the last known theme before the first paint (the server copy is applied after sign-in).
applyThemeClass(resolveTheme(readStoredTheme() ?? 'dark'))

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing from index.html')

createRoot(root).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
)
