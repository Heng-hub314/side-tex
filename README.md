# dsh-better-latex

DSH 内置的 LaTeX 工作台：**左边源码、右边 PDF**，两侧用 SyncTeX 双向定位，改动以**源码 diff** 逐处接受 / 放弃 / 评论，Host 侧内置实时编译。

面向 DSH（DeepSeek Harness）的 profile 插件，Host/Client 两半：

- **Host**（`lib/index.js`）：项目状态、latexmk 编译、SyncTeX 正/反查、基线快照与逐 hunk 决策、批注存储，以及 `/dsh-latex/*` 路由与两个模型工具。
- **Client**（`lib/client.js`）：把 `LaTeX` 标签页注册进 DSH 原生右侧栏，左右分栏（可拖分隔条）。

## 交互

| 动作 | 结果 |
| --- | --- |
| 打开 LaTeX 标签页 | 左栏显示主文件源码（行号 + 改动高亮），右栏显示编译产物 PDF |
| 左栏**单击某行** | 进入行内编辑：该行变输入框，`Enter` 保存、`Esc` 取消、失焦（内容有变）自动保存；改动写回 `.tex` 并进「改动」页签待审。编辑框右侧 `⌖` 可定位到 PDF |
| 左栏**双击某行** | SyncTeX 正查 → 右栏滚到对应位置，并在 PDF 上常驻一个蓝色定位框 |
| 右栏**单击 PDF 某处** | SyncTeX 反查 → 左栏切换到该文件、高亮并滚动到对应行（双击等价，不做双击计时，避免设备差异导致失效） |
| PDF 面板头 `✎ 批注模式` | 打开后单击 PDF 就地开批注框；不开也能拖框批注 |
| 左栏 **Shift+单击** | 以当前行为起点选一段（`L20–L23`）；行号旁 `+` 或头部「批注选区」按整段写批注 |
| 左栏行号旁 `+`（悬停出现） | 以该行为锚点写批注；锚点同时画在 PDF 上 |
| PDF 上**拖框** | 框住多行 → 反查成连续行区间（如 `#L20–L23`），批注锚定整段并引用整段原文；覆盖多个文件时草稿里可切换锚点 |
| 「加入任务」→「发送到对话」 | 每条批注写成 `@文件#L起–L止（N 行）` + 逐行原文引用 + 批注，追加到会话输入框 |
| 改 `.tex` 后（agent 改或手动编辑） | 顶部出现「审阅 N」；左栏「改动」页签显示逐 hunk 的 unified diff（红删 / 绿增） |
| 「改动」页签的 `↵ 自动换行` | 改动面板长行默认折行（不再横向滚动）；与源码面板共用同一个持久化开关，可在任一侧切换 |
| 接受 / 放弃 / 评论 | 逐 hunk 决策：接受后该段进入基线；放弃后该段恢复原版；评论写入对话并保留改动 |
| 撤销上一步 | 回退上一次决策（文件与基线一起，最多 20 步） |
| 引擎 / 主文件 / 自动编译 | 工具栏直接切换；`⤢` 把右栏放大成全屏 |
| 布局 | 「分栏 / 源码 / PDF」三档；分隔条可拖动，比例会记住 |
| `Aa` | 代码样式：字体（JetBrains Mono / Fira Code / Cascadia Code / Consolas，缺失自动回落）、字号 10–20、自动换行开关（源码与改动两个面板都生效）；三项都记住 |

定位与审阅都在同一条工作流里：**在 PDF 上指位置 → 左栏立刻看到对应源码 → 改动在源码里逐处决策**。不再生成「排版前后两张裁剪图」。

## 安装

```sh
dsh plugin --profile desktop add link:C:\path\to\DSH-Better-Latex
```

依赖：TeX Live / MiKTeX（`latexmk`，建议含 `synctex`）；pdf.js 复用 profile 现有 `pdfjs-dist`，缺失时降级为内嵌 PDF（此时 PDF 只读：双向定位与批注不可用，编译与源码审阅仍可用）。首次安装需重启 DSH，之后改代码用插件列表关→开即可热重载，再刷新页面。

## 运行时数据

| 路径 | 内容 |
| --- | --- |
| `<项目>/.dsh-latex/settings.json` | 主文件、引擎、自动编译、超时、构建目录等 |
| `<项目>/.dsh-latex/build/` | 当前 PDF 与 `.synctex.gz` |
| `<项目>/.dsh-latex/baseline/` | 已接受的源文件快照（manifest + 副本） |
| `<项目>/.dsh-latex/notes.json` | PDF 批注（页面矩形、源码行区间 `line`/`endLine`、原文 `quote`、批注文字；旧版只有 `line` 的条目按单行读取） |
| `%TEMP%/dsh-better-latex-compare/<hash>/` | 基线镜像编译产物（工具/脚本用；UI 不再读取） |

是 git 仓库时自动把 `.dsh-latex/` 写进 `.git/info/exclude`，不改你的 `.gitignore`。

## 编辑语义

- 手动编辑走 Host 的 `write.source`：**原子写**（临时文件 + rename）+ **mtime CAS**；期间 agent 也改了同一文件 → 冲突提示并重新拉取源码，不覆盖。
- 保存后基线不变，所以改动进入「改动」页签；接受后基线更新，放弃则写回旧行。手动编辑与 agent 编辑共用同一套审阅/撤销。
- 保存时会触发一次编译（未开「自动编译」也补一次），PDF 随即刷新。

## 编译语义

- **编译 cwd = 主文件所在目录**：`\input{}`、`\includegraphics{}`、`\bibliography{}` 的相对路径与 bibtex 找 `.bib` 都按它解析（主文件放在子目录里也成立）；产物目录传绝对路径，仍写在 `<项目>/.dsh-latex/build/`。
- latexmk 负责引擎选择、rerun 与 BibTeX/Biber；日志里的相对路径会按编译 cwd 还原成项目内相对路径再展示。
- SyncTeX 的源码路径解析同样以主文件目录为基准，最后归一化成项目内相对路径。

## 审阅语义

- 基线 = **用户已接受**的版本；项目首次打开时用当前文件初始化。
- **编译不更新基线**，所以 agent 的改动不会被自动吞掉。
- 逐 hunk 决策：接受的行进入基线；放弃的行恢复原版；**未决定**的行留在工作副本里、基线保持旧值，继续显示为待审阅。
- 只有源码级 diff；不再做排版前后对比编译，也不再依赖 SyncTeX 锚点来呈现改动。
- 文件在决策期间被改动（mtime 不符）→ 冲突，不覆盖，自动重新拉取 diff。
- 对没有改动的文件调用接受/放弃是 no-op：不重写文件、也不计入结果（避免无谓刷新 mtime 触发重编译）。

## 工具

- `latex_compile`：编译并返回页数、耗时、`file:line: message` 错误、SyncTeX 往返自检。
- `latex_review`：`list` / `diff` / `accept` / `reject` / `undo`；`path` + `hunks` 可逐 hunk 决策。accept/reject/undo 属于用户决定，模型只在用户明确要求时调用。

## 自检

```sh
node scripts/selftest.mjs
```

在 `example/` 上跑 20 项：主文件探测、编译、SyncTeX 往返、图表与参考文献解析、`\input` 子文件的 SyncTeX 往返、矩形→行区间（多行/单行/子文件）、改动检测、逐文件接受/放弃、干净文件拒绝的重写保护、子文件改动检测、基线排版重建、审阅锚点 + 逐 hunk 决策 + 撤销、批注持久化（含 `endLine` 与多行引用）。

示例工程（`example/`）刻意覆盖常见编译需求：

| 文件 | 用途 |
| --- | --- |
| `paper.tex` | 主文件：公式、图表、参考文献、`\input` 子文件 |
| `figures/phase.pdf` | `\includegraphics` 的矢量图（matplotlib 生成） |
| `refs.bib` | BibTeX 参考文献（占位条目，仅作 fixture） |
| `sections/appendix.tex` | `\input` 的子文件，用于验证多文件定位与改动审阅 |

## 限制

- 不做 Papilot 的逐词向量 SVG diff / 移动段落识别；用行级 patience diff 替代。
- 不做 PDF 文字选择层：用「单击定位 + 拖拽自由框」，另有「批注模式」单击落点；源码侧是「单击编辑、双击定位、Shift+单击选段」。
- 一条批注最多覆盖 120 行；引用原文最多 40 行 / 3000 字符（超出截断）。矩形解析不到 synctex 记录时回退为单点反查。
- 源码面板一次最多渲染 3000 行、PDF 一次最多 24 页（超出提示），避免大文档拖垮侧栏。
- 代码字体用本机已安装的字体（不打包 web font，离线可用），未安装时按栈回落；源码页签关闭连字（`font-variant-ligatures: none`），避免 `--`、`->` 被渲染成符号。源码与改动两个面板都支持自动换行（默认开）。
- 不改 DSH 本体；不涉及 git worktree / 三方合并（沿用基线快照 + CAS）。
