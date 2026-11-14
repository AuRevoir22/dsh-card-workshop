# 卡片工坊 · dsh-card-workshop

把教材、课件或试卷 PDF 拆成**定义卡、定理卡、题型卡**，编成一份 A4 卡片 PDF，按子文件夹归档。

给 DSH 桌面端用的插件：左侧栏一个入口，点开选文件、选子文件夹，剩下的交给对话里的模型逐页读、归类、写详解。

## 出什么

- **定义卡**：术语 + 原文定义 + 记号 / 要害 / 用法
- **定理卡**：条件、结论分行写，证明照原文，原文没证明的补上
- **题型卡**：认题特征 + 通法 + 易错点 + 该题型每道题的完整题干、切入点、完整详解
- 封面、索引（带真实页码）、PDF 书签；同名题型自动并成一张卡，题目一道不删

## 环境要求

| 依赖 | 说明 |
|---|---|
| DSH 桌面端 | 0.2.x 测过 |
| MiKTeX | 25.12 测过，要 `xelatex` 和 `ctex` 宏包 |
| poppler | `pdftotext` / `pdftoppm` / `pdfinfo`，MiKTeX 自带 |

`xelatex`、`pdftotext` 这些必须在 PATH 里，否则面板能开、出不了 PDF。

## 安装

插件管理器里搜 `dsh-card-workshop`，或者 `install_bundle` 目标填：

```
dsh-card-workshop
github:你的用户名/dsh-card-workshop
```

装完左侧栏出现「卡片工坊」。

## 用法

1. 面板里选**母文件夹**（默认 `D:\卡片库`，可以换）
2. 选**一到两级子文件夹**。不存在时会问「名字打错了，还是新建」，不会自己建
3. 选**源 PDF**，可以多份，内容合并成一份卡片集
4. 点「交给 AI」，新对话里模型按 `.work/<批次>/plan.md` 逐段施工

模型这侧有五个工具：`cards_prepare`（拆页、脱敏、写施工单）、`cards_page_image`（按需取页图）、`cards_check`（覆盖率体检）、`cards_build`（排版编译）、`cards_list_folders`（列子文件夹）。

## 产物

```
母文件夹/
├─ 高等数学/
│  └─ 第一章 极限/
│     └─ 第一章 极限-20261114-180937.pdf
└─ .work/            中间产物，编完自动删
```

同一批次重编会覆盖同名文件，不会堆一堆 `-01`、`-02`。

## 隐私

拆页时会把校名、姓名、班级、学号、电话、邮箱替换成「某校 / 某某 / ××」。替换只写计数，不把原文留在任何中间文件里。

## 已知限制

- **只在 Windows 上测过**。客户端拼路径用反斜杠，macOS / Linux 会拼错
- 文字层是 CID 乱码的 PDF（很多 PPT 导出的课件都这样）没有文字可读，只能整本出图，token 消耗会明显上去
- 每道题都写完整详解，页数和成本都不小。建议一次 20 页上下，分批做

## License

MIT，见 [LICENSE](./LICENSE)。

---

## English

Splits a textbook or exam PDF into definition, theorem, and problem-type cards, renders them as one A4 card PDF, and files it under a subfolder of your card library.

A DSH desktop plugin: one sidebar entry, pick a PDF and a subfolder, and the agent reads it page by page, classifies the problems, writes the solutions.

Requires DSH desktop, MiKTeX with `xelatex` + `ctex`, and poppler (`pdftotext`, `pdftoppm`, `pdfinfo`) on `PATH`. Tested on Windows only.

Install with `install_bundle` targeting `dsh-card-workshop`. MIT licensed.
