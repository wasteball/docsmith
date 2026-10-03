# Docsmith 导出修复与图文卡片移除设计

日期：2026-10-01
状态：已确认；两个阶段分别按 v1.17.2 与 v2.0.0 执行

## 1. 目标与边界

本次工作分成两个彼此独立的产品事项，并在每个事项完成、验证后单独发布：

1. 修复 PDF 导出准备过程偏慢，以及 Mermaid 图表在打印/PDF 中异常变宽的问题。
2. 从产品中完整移除“图文卡片”能力。

保留浏览器原生“打印 → 另存为 PDF”路径，不引入 PDF 引擎、字体包或新的运行时依赖。整篇 PNG 导出合同不变：一篇 Markdown 仍只生成一张 PNG。

## 2. 当前实现与问题边界

### 2.1 PDF / Mermaid

当前调用链为：

```text
MDW.exportPdf()
  -> printInPlace()
  -> whenDiagramsReady(preview)
  -> preparePrintDiagrams()
  -> window.print()
```

若当前能力仍在 iframe 中，或 `window.print()` 不可用，则回退为：

```text
buildStandalone({ autoPrint: true })
  -> whenDiagramsReady(preview)
  -> 收集文档 CSS / KaTeX 字体
  -> 打开打印标签页
  -> window.print()
```

Mermaid 图表由本地官方 Mermaid 渲染；图表队列必须保持串行，因为 Mermaid 使用全局配置和临时 DOM。不能用并行渲染作为未经验证的“提速”手段。

当前宽度相关逻辑集中在 `workspace.js` 的 `svgBox()`、`svgDims()`、`prepSvg()`、`preparePrintDiagrams()` 和 `doc.css` 的打印规则。屏幕画布需要保留图表固有尺寸供缩放/拖拽；打印输出则必须受页面可打印宽度约束。两种场景不能共用会互相覆盖的内联尺寸。

### 2.2 图文卡片

图文卡片通过 `core/config.js` 的 capability 注册进入导航；卡片页面、偏好记忆、设置展示和文案均有独立引用。文件库仍复用 `src/views/files/` 中的 `zip-writer.js`，该共享文件不能删除。

## 3. 阶段一：PDF / Mermaid 修复（发布 v1.17.2）

### 3.1 诊断先行

使用真实夹具：

`areas/职业发展/求职/作品集/仓网规划助手/03-05 作品集_仓网规划助手_脱敏展示版.md`

该夹具当前包含 8 个 Mermaid 围栏。记录以下边界耗时和几何数据：

- `setText()` 到图表队列完成；
- 图表队列完成到 `exportPdf()` 触发打印；
- `svg.viewBox`、`svg.getBBox()`、屏幕 SVG 矩形和打印态 SVG 矩形；
- 是否出现横向溢出、图表被裁剪或图表内容变形。

如果主要耗时来自浏览器打印预览本身，而不是 Docsmith 的准备过程，则不把外部等待误报为代码优化成果；只修复可控的准备阶段。

### 3.2 实现原则

1. **避免重复等待**：对同一轮 Mermaid 渲染，只完成一次布局稳定化；PDF 点击时复用已经完成的 readiness/布局结果。文档内容或主题导致渲染令牌变化时，必须重新等待。
2. **不改变渲染顺序**：保留 Mermaid 串行队列、取消令牌、超时和错误提示。
3. **统一打印边界**：打印前以真实 SVG 内容边界计算宽高比例，并通过打印 CSS 的受约束父容器和 SVG 规则输出；不得把屏幕 pan/zoom 的 transform 或超大固有宽度带进打印布局。
4. **保留回退路径**：直接打印不可用时，继续使用现有自包含 HTML 打印标签页；样式/字体收集失败仍然明确提示，不静默生成裸页面。
5. **共享函数修复**：宽度和 readiness 逻辑只在公共函数修复，不在单个导出按钮上堆叠特殊判断。

预计修改范围限制在：

- `src/views/markdown/workspace.js`
- `src/views/markdown/doc.css`
- 现有导出/图表 smoke，必要时新增一条针对真实夹具的最小回归检查
- `docs/CHANGELOG.md`、`manifest.json`、版本说明和 README 的当前版本信息

不新建 PDF 服务，不改 Mermaid 版本，不删除整篇 PNG 能力。

### 3.3 阶段一验收

- 真实夹具的 8 张 Mermaid 图全部渲染成功；
- 打印态每张图的 SVG 宽度不超过可打印正文宽度，不出现横向溢出；宽图仍保持比例，内容不被裁剪；
- `exportPdf()` 只触发一次打印调用，且已完成的图表不会被重复渲染；
- 现有 HTML、Word、PNG 导出和 Mermaid 回归检查不退化；
- `git diff --check`、JS 语法检查和浏览器 smoke 通过；
- 更新为 `1.17.2`，CHANGELOG 说明原因后，提交、打 `v1.17.2` tag 并推送 `main` 与 tag。

## 4. 阶段二：移除图文卡片（发布 v2.0.0）

### 4.1 运行时代码

- 从 `src/core/config.js` 的 `CAPABILITIES` 删除 `cards` capability；同步修改品牌副标题和不再适用的 `ORDER_VERSION` 注释，但不为了删除一个未知 ID 而重置用户菜单顺序。
- 从 `src/core/prefs.js` 删除全部 `cards.*` 默认值。
- 从 `src/app/main.js` 删除 cards 作用域 CSS、卡片偏好设置组和 cards 专用格式化分支。
- 删除整个 `src/views/cards/` 目录及其空示例占位文件。
- 不修改通用数字快捷键、文件库快捷键和文件库使用的 `zip-writer.js`。

### 4.2 持久化清理

在现有 `restoreIfEmpty()` 完成之后做一次性清理：

- 从 `KEYS.prefs` 中移除 `cards.*` 字段；
- 从 shell 的 `order`、`hidden` 和 `activeId` 中移除 `cards`；
- 通过现有 store 写回，避免旧字段继续进入配置备份。

清理必须发生在恢复之后，避免旧的 Chrome 镜像再次把已删除字段恢复回来。只清理 cards 命名空间，不触碰其他偏好和用户自定义能力。

### 4.3 产品文案与文档

同步移除当前产品宣传中的图文卡片能力：

- `manifest.json` 描述；
- `src/views/welcome/index.html` 当前功能宣称；
- `README.md` 功能列表、离线能力说明、源码目录说明和当前版本；
- 版本说明中的当前版本和不再适用的示例。

CHANGELOG 中已发布版本的历史记录保留，不为了“全仓库零 cards 字符串”破坏历史；新增的 `2.0.0` 记录明确说明能力及其偏好/导航已移除。备份文档中的失效 cards 路径替换为仍存在的文件。

### 4.4 阶段二验收

- 新启动后导航只显示剩余能力；旧的 `activeId: cards` 能回落到有效能力；
- 设置中的“记住了我什么”不再出现卡片偏好；导出的配置不再包含 `cards.*`；
- `src/views/cards/`、`DSCards`、当前文案中的卡片能力引用均清理；通用 review card、布局 card 和“图文说明”不误删；
- Markdown、文件库、文件库 ZIP 下载仍可用；
- JS 语法检查、静态引用检查和 `git diff --check` 通过；
- 更新为 `2.0.0`，提交、打 `v2.0.0` tag，并推送 `main` 与 tag。

## 5. 错误处理与回退

- Mermaid 超时或渲染失败时保留源码回退和现有错误提示，不能生成看似成功但缺图的 PDF/网页。
- `window.print()` 不可用时走现有打印标签页；弹窗被拦截时给出可操作提示。
- 卡片迁移只做白名单删除；迁移失败不能阻塞 Markdown 或文件库启动，且应记录可诊断错误。
- 任一阶段验收失败，不递增版本、不打 tag、不推送，先修复后再发布。

## 6. 版本与发布顺序

当前基线为 `1.17.1`。按用户可感知影响拆成两次发布：

1. PDF/Mermaid 仅为修复：`1.17.2`。
2. 移除内置能力是用户可感知且不兼容的产品变化：`2.0.0`。

每次发布顺序固定为：备份 → 修改 `manifest.json` 和 CHANGELOG → 检查/浏览器验证 → commit → `git push origin main` → 创建对应 `v<version>` tag → `git push origin v<version>`。
