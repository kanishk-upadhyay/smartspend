import { useEffect, useState } from 'react';
import { applyThemePreference, getStoredThemePreference, THEME_STORAGE_KEY } from '../lib/theme';
import type { ThemePreference } from '../lib/theme';

// Editorial palette — magenta carries the one-voice rule. Pie slices step through a
// single-hue tonal scale (graphite → ash) with magenta only on the leading slice.
const SLICE_COLORS_LIGHT = [
  'oklch(60% 0.25 350)',
  'oklch(25% 0 0)',
  'oklch(40% 0 0)',
  'oklch(55% 0 0)',
  'oklch(70% 0 0)',
  'oklch(82% 0 0)',
];
const SLICE_COLORS_DARK = [
  'oklch(68% 0.22 350)',
  'oklch(78% 0.01 350)',
  'oklch(64% 0.01 350)',
  'oklch(50% 0.01 350)',
  'oklch(38% 0.01 350)',
  'oklch(30% 0.01 350)',
];
const ACCENT_LIGHT = 'oklch(60% 0.25 350)';
const ACCENT_DARK = 'oklch(68% 0.22 350)';
const TEXT_DIM_LIGHT = 'oklch(55% 0 0)';
const TEXT_DIM_DARK = 'oklch(78% 0 0)';
const GRID_STROKE_LIGHT = 'oklch(92% 0 0)';
const GRID_STROKE_DARK = 'oklch(28% 0 0)';
const TOOLTIP_FILL_LIGHT = 'oklch(92% 0 0 / 0.4)';
const TOOLTIP_FILL_DARK = 'oklch(28% 0 0 / 0.4)';

export function useTheme() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(getStoredThemePreference);

  useEffect(() => {
    applyThemePreference(themePreference);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      // ignore storage failures
    }
  }, [themePreference]);

  const setThemeAndPersist = (nextTheme: ThemePreference) => {
    setThemePreference(nextTheme);
    applyThemePreference(nextTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // ignore storage failures
    }
  };

  // Theme-aware chart colors
  const isDarkTheme = themePreference === 'dark' || (themePreference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const SLICE_COLORS = isDarkTheme ? SLICE_COLORS_DARK : SLICE_COLORS_LIGHT;
  const ACCENT = isDarkTheme ? ACCENT_DARK : ACCENT_LIGHT;
  const TEXT_DIM = isDarkTheme ? TEXT_DIM_DARK : TEXT_DIM_LIGHT;
  const GRID_STROKE = isDarkTheme ? GRID_STROKE_DARK : GRID_STROKE_LIGHT;
  const TOOLTIP_FILL = isDarkTheme ? TOOLTIP_FILL_DARK : TOOLTIP_FILL_LIGHT;

  return {
    themePreference,
    setThemePreference,
    setThemeAndPersist,
    isDarkTheme,
    SLICE_COLORS,
    ACCENT,
    TEXT_DIM,
    GRID_STROKE,
    TOOLTIP_FILL,
  };
}
