export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'smartspend:theme';

export const getStoredThemePreference = (): ThemePreference => {
  if (typeof window === 'undefined') return 'system';
  const value = window.localStorage.getItem(THEME_STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
};

export const resolveTheme = (preference: ThemePreference): ResolvedTheme => {
  if (preference === 'light' || preference === 'dark') return preference;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

export const applyThemePreference = (preference: ThemePreference) => {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
};
