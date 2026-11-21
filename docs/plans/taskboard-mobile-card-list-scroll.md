# 手机看板卡片列表无法滚动

任务：[#31 手机上不能上下滚动，直接被截断了](https://task.loopq.cn/?t=31)

## 现象

手机（≤640px）上，一个分组里的卡片超过一屏后，列表不能上下滑，超出部分直接被裁掉，最后几张卡永远看不到。

## 根因

`f09ac87`（视觉重做）把手机当前列从 flex 改成了 grid：

```css
.col.mobile-current { display: grid; grid-template-rows: auto minmax(0, 1fr); align-items: start; }
```

`align-items: start` 让 `.cards` 这个 grid item 不再被拉伸到第二行的高度，而是按内容撑高（实测 25 张卡时 2044px）。所以 `.cards` 的 `clientHeight === scrollHeight`，自身的 `overflow-y: auto` 没有东西可滚；超出部分再被 `.board { overflow: hidden }` 裁掉。

本地复现（390×664，WebKit / Chromium 一致）：`.cards` 高 2044px，看板底边 664px，最后一张卡底边 2220px，不可见。

## 修复

手机媒体查询里的 `.cards` 加一行：

```css
max-height: 100%;
```

grid item 的百分比高度按所在网格区域（第二行 `minmax(0, 1fr)`，确定高度）计算。内容短时 `.cards` 仍按内容高度显示，内容超出时被限制在区域内，靠自己的 `overflow-y: auto` 滚动。

不用 `align-self: stretch`：它会把空列的虚线框（现在 `min-height: 140px`）拉满整屏，改变现有外观。

## 验证

- Playwright（WebKit + Chromium，390×664，生产构建 + 本地 API + 临时库）：`.cards` 高度落在看板内，`scrollHeight > clientHeight`，滚到底后最后一张卡可见；空列虚线框仍是 140px
- `cd web && npm run build`
- 发布前门禁：`cd api && npm run check`、`npm run test:push`、`bash api/test/rules.sh`
- iPhone 主屏 web app 真机手感交用户验收
