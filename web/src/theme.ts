import { ref } from 'vue';

/** 主题偏好：跟随系统 / 亮 / 暗，存本机。首帧由 public/theme.js 套上，这里负责之后的切换 */
export type ThemePref = 'system' | 'light' | 'dark';
export const THEME_LABEL: Record<ThemePref, string> = { system: '跟随系统', light: '亮色', dark: '暗色' };
const KEY = 'taskboard.theme';
const NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const stored = localStorage.getItem(KEY);

export const themePref = ref<ThemePref>(stored === 'light' || stored === 'dark' ? stored : 'system');

// 与 public/theme.js 同一套规则，改一处要同步另一处
function apply() {
  const dark = themePref.value === 'dark' || (themePref.value === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content = dark ? '#0e0f13' : '#f4f4f0';
}
// 只有「跟随系统」时才受系统切换影响；固定档位下 apply() 结果不变，无需解绑
systemDark.addEventListener('change', apply);

export function cycleTheme() {
  themePref.value = NEXT[themePref.value];
  localStorage.setItem(KEY, themePref.value);
  apply();
}
