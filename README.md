# 冰痕 · Ice Imprint

纯前端的三层纸张撕裂互动页面。支持鼠标拖拽、双手摄像头捏合拉开、弹性布料变形、不规则裂缝、粒子效果和累计撕裂。

## GitHub Pages

上传本目录中的**内容**到仓库根目录，确认 `index.html` 与 `app.js` 在同一层，不要再套一层“冰痕 2”文件夹。然后在 GitHub 仓库的 Settings → Pages 中选择部署分支和根目录。

仓库根目录应包含：

```text
index.html
style.css
app.js
gesture.js
assets/
```

默认背景图使用 `assets/layer-1.png`、`layer-2.png`、`layer-3.png`，使用英文文件名以避免 Pages 路径编码问题。摄像头需要 HTTPS；GitHub Pages 默认提供 HTTPS。

## 本地运行

摄像头不能通过 `file://` 启动，请运行：

```bash
python3 -m http.server 8765
```

再访问 <http://127.0.0.1:8765/>。
