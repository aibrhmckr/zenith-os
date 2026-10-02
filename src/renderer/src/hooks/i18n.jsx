/* eslint-disable react/prop-types, react-refresh/only-export-components -- Application context and hook share the same module. */
import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import en from '../locales/en.json'
import tr from '../locales/tr.json'
/**
 * Default English translation context; a missing provider still returns dictionary text or the
 * key.
 */
const Context = createContext({ language: 'en', t: (key) => en[key] || key })
/**
 * Own English/Turkish language selection, persistence, and the document lang attribute; share a
 * stable translation interface with descendants.
 *
 * @param {Object} options - Named inputs for this operation.
 * @param {import("react").ReactNode} options.children - Nested content rendered within the provider, dialog, or hint.
 */
export function I18nProvider({ children }) {
  /**
   * Persisted en/tr UI language; document lang and translations follow the same value.
   */
  const [language, setLanguageState] = useState(() =>
    localStorage.getItem('zenith-language') === 'tr' ? 'tr' : 'en'
  )
  /**
   * Keep the document language synchronized with the translation context.
   */
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])
  /**
   * Normalize the selected language to en/tr and persist it before updating React and document
   * language.
   *
   * @param {*} value - Input value being normalized, displayed, or committed by this helper.
   */
  const setLanguage = useCallback((value) => {
    const next = value === 'tr' ? 'tr' : 'en'
    localStorage.setItem('zenith-language', next)
    document.documentElement.lang = next
    setLanguageState(next)
  }, [])
  /**
   * Look up a message in the selected dictionary with English/key fallbacks for missing
   * translations.
   *
   * @param {string|number} key - Action/cache/preference key or input code used by this operation.
   */
  const t = useCallback((key) => (language === 'tr' ? tr : en)[key] || en[key] || key, [language])
  const value = useMemo(
    /**
     * Derive value's cached value; React invalidates it only when the declared dependencies change.
     */
    () => ({ language, setLanguage, t }),
    [language, setLanguage, t]
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}
/**
 * Read the nearest localization provider to access the language, setter, and translation lookup.
 */
export const useI18n = () => useContext(Context)
