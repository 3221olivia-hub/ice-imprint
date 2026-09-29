# 冰痕 · Ice Imprint

一个纯前端的互动纸张撕裂体验。画面由三层背景组成，拖拽或用摄像头识别双手捏合并拉开，纸面会产生弹性变形、粒子和不规则裂缝。每次小撕裂会保留在当前页面，累计撕开约一半后才切换到下一层。

## 本地运行

需要通过 HTTP 服务打开页面，直接双击 `index.html` 会无法启动摄像头。

```bash
python3 -m http.server 8765
```

然后访问 <http://127.0.0.1:8765/>。

## GitHub Pages

将本目录的全部文件上传到仓库，在 GitHub 的 **Settings → Pages** 中选择分支和根目录即可发布。摄像头功能需要 HTTPS；GitHub Pages 默认提供 HTTPS。

MediaPipe Hands 会优先加载仓库内的 `vendor/mediapipe-hands/`，没有本地 bundle 时自动使用 jsDelivr CDN。手势识别需要允许浏览器访问摄像头。

## 文件说明

- `index.html`：页面结构
- `style.css`：液态玻璃视觉样式
- `app.js`：三层画布、布料约束、撕裂累计和摄像头交互
- `gesture.js`：双手捏合与拉开进度计算
- `assets/`：默认画面和透明 logo

图片上传只使用浏览器内存中的 `URL.createObjectURL`，最多选择三张，不会上传服务器。
