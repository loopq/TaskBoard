// 首帧前套上主题，避免先亮后暗闪一下（CSP 不许内联脚本，所以是单独文件）。
// 解析规则与 src/theme.ts 的 apply() 相同，改一处要同步另一处。
(function () {
  var pref = localStorage.getItem('taskboard.theme') || 'system';
  var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0e0f13' : '#f4f4f0';
})();
