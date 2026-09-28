/* eslint-disable react/prop-types, react-refresh/only-export-components -- Application context and hook share the same module. */
import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import en from '../locales/en.json'
import tr from '../locales/tr.json'
const Context = createContext({ language: 'en', t: (key) => en[key] || key })
export function I18nProvider({ children }) {
  const [language, setLanguageState] = useState(() =>
    localStorage.getItem('zenith-language') === 'tr' ? 'tr' : 'en'
  )
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  const setLanguage = useCallback((value) => {
    const next = value === 'tr' ? 'tr' : 'en'
    localStorage.setItem('zenith-language', next)
    document.documentElement.lang = next
    setLanguageState(next)
  }, [])
  const t = useCallback((key) => (language === 'tr' ? tr : en)[key] || en[key] || key, [language])
  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export const useI18n = () => useContext(Context)
