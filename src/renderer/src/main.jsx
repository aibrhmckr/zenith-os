/** Mount the isolated renderer once. StrictMode exercises effect cleanup; I18nProvider supplies language and fallback dictionaries to every dashboard surface. */
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './hooks/i18n'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
