# cortico-world-screen-companion · 屏幕陪伴桌宠

Coopanion（Cortico）的 World 扩展：桌宠观察用户当前屏幕，把截图作为**图片附件**交给宿主的多模态模型，模型结合画面自然回应。**不需要用户主动说话**——自动观察默认开启，画面变化时桌宠会主动开口。

主要使用场景是浏览器里的微信读书，但这是一个**通用屏幕观察**能力：用户看文章、逛 GitHub、刷普通网页时同样适用，桌宠按实际截图内容理解并回应，不预设用户一定在阅读。

## 它做什么

- **自动观察（默认开启）**：按固定间隔截屏比对画面，画面变化明显时把当前截图作为 `screen_companion.observed` 事件（图片附件）交给宿主模型，桌宠结合画面主动开口。
- **手动触发**：提供工具 `screen_companion_look_now`，用户说话（如「看看我现在在看什么」）时截屏，模型结合画面 + 问题回答。
- 截图以 `image/jpeg` 图片附件通过工具回执或事件的 `blobs` 机制交给宿主模型，无需插件自带视觉模型、不做任何外部 API 调用。
- 默认截主显示器；多屏时可配置显示器 id。截图超宽时等比缩小（默认最大 1920px），兼顾中文文字可读性与视觉 token 成本。

## 安装

1. 在 Coopanion 设置里打开**高级模式**，进入**扩展**页，选择**本机目录**安装本包的目录（link 安装，改代码后重启进程生效）。
2. 在 World 页启用「屏幕陪伴桌宠」。
3. 使用支持视觉（多模态）能力的模型——这是唯一的前置条件，插件本身不调用任何外部 API。

## 配置（worlds.screen-companion.*，全部热改生效）

| 键 | 默认 | 说明 |
|---|---|---|
| autoObserve | true | 自动观察开关。开启后定期截屏，画面变化时把截图交给模型，桌宠主动开口；关闭后仅手动触发。 |
| captureIntervalMs | 3000 | 自动观察的轮询间隔（ms）。只比对画面变化，不调用模型，成本很低。 |
| motionThreshold | 0.05 | 画面变化阈值（0-1）。降采样画面上变化像素占比超过该值才推给模型。调大更省调用、更安静，调小更灵敏。 |
| screen | （空） | 截取哪台显示器。空 = 主屏；多屏填系统显示 id（如 `\\.\DISPLAY2`）。 |
| maxWidth | 1920 | 截图最大宽度（px），超过时等比缩小以省 token。1920 保持 1080p 原分辨率，中文清晰。 |

自动观察两次推送之间内置 20 秒冷却，避免视频等持续变化场景下桌宠过于频繁开口。

## 使用

**自动观察**：启用 World 后无需说话。桌宠会盯着屏幕，你在微信读书翻页、切换网页、滚动文章等导致画面变化时，桌宠会结合画面主动开口（例如评论你正在看的内容、提醒你注意到的东西）。如果画面里没什么值得说的，它会保持安静。

**手动触发**：也可以直接说话让桌宠看一眼，例如：

- 「看看我现在在看什么。」
- 「帮我解释屏幕上的这段文字。」
- 「你觉得这个页面怎么样？」

此时桌宠调用 `screen_companion_look_now`（把用户的问题放进 `question` 参数），得到截图后结合画面与上下文回答。

## 开发

```bash
corepack pnpm install
pnpm typecheck        # 类型检查
pnpm test             # 运行测试
pnpm build:describe   # 由源码自描述重新生成 describe.json
pnpm smoke            # 本机真实截屏冒烟测试（不经过 Coopanion）
```

只依赖 `jimp`（图像缩放、尺寸读取与画面变化比对）；截屏走 Windows 自带的 PowerShell + .NET `System.Drawing`，无第三方二进制、无原生编译。

## 测试

```bash
pnpm test
```

覆盖：工具注册、截图数据处理（等比缩放 / 读取尺寸）、画面变化哨兵、自动观察（画面变化推送、冷却去重、开关关闭）、成功返回（含图片附件）、截图失败、模型无法处理图像、未挂载、配置热改、describe.json 与源码自描述一致。

## 验收步骤

若当前环境可访问 Coopanion，按此人工验收：

1. 启用 World 并确认使用支持视觉的模型（自动观察默认开启）。
2. 打开微信读书某个页面，滚动或翻页制造画面变化，桌宠应能主动开口提及画面中可见的内容。
3. 切到任意普通网页（或 GitHub），再制造画面变化，桌宠应能根据**新截图**理解页面。
4. 直接问「帮我解释屏幕上的这段文字」，桌宠应调用手动工具并结合截图回答。
5. 关闭 `autoObserve` 后，画面变化不再触发自动开口；说话触发仍可用。
6. 换成不支持视觉的模型后，工具应返回明确失败说明。

若无法访问真实 Coopanion，`pnpm typecheck && pnpm test` 通过即可作为本地验证；真实安装步骤见上文「安装」。

## 已知限制

- 截图是整个显示器（主屏或指定屏），不是单个前台窗口；多窗口重叠时画面即所见。
- 截图只代表**当前这一刻**，不代表用户完整阅读历史；环境提示词已向模型说明这一点。
- 自动观察基于「画面像素变化」判定，不会理解画面内容后再决定是否开口——判断「值不值得说」交给宿主的模型完成。
- 未接入 OCR / 浏览器 CDP / 前台窗口捕获，网页内容不做专门识别。
- 多屏混用不同 DPI 缩放时，`System.Drawing` 按逻辑坐标截取，指定副屏可能并非物理像素分辨率；单屏或统一缩放不受影响。

## 实现说明

参考了以下本地仓库（均为 MIT 许可）：

- `cortico-world-wows`：World 生命周期（start/stop）、画面哨兵（MotionSentinel 降采样逐像素比对）、`pushEvent` 主动推送事件、`jimp` 等比缩放、工具声明与 `describeTools` 自描述。
- `cortico-world-bilibili-video` / `cortico-world-browser`：图片附件传递机制——工具回执或事件返回 `blobs: [{ bytes, mime, name, fallbackText }]`，由宿主按模型 MIME 支持决定是否附加图像。

**图片如何传给宿主模型**：工具回执或 `pushEvent` 事件的 `blobs` 字段携带 JPEG 字节，宿主落库并转为附件句柄；当模型接受 `image/jpeg` 时把图片内容直接交给模型，否则只附 `fallbackText`。插件不做任何网络调用，视觉理解完全由宿主的多模态模型完成。

**自动观察如何工作**：`start` 后按 `captureIntervalMs` 定时截屏，`MotionSentinel` 把截图降采样到 320 宽与上一帧逐像素比对；变化比例超过 `motionThreshold` 且过了 20 秒冷却时，用 `host.pushEvent(..., { trigger: 'debounce' })` 把截图作为图片附件推给宿主，模型结合环境提示词决定是否开口、说什么。

**截图如何取得**：用 `powershell.exe -EncodedCommand` 调 .NET `System.Drawing` 的 `CopyFromScreen`，内存中编码为 JPEG 后以 base64 回传，`jimp` 做等比缩放。原本参考 wows 的 `screenshot-desktop` 方案（其 Windows 端用 polyglot `.bat` 现场编译 C#，再以裸名 `%~n0.exe` 从当前目录调用）在本机被环境变量 `NoDefaultCurrentDirectoryInExePath=1` 禁用而失败，故换成 PowerShell 直调，去掉 csc.exe 编译与裸名 exe 依赖。

**运行所需的模型能力**：宿主模型需支持图像输入（`image/jpeg`）。本插件用 `WorldHost.modelFacts.accepts('image/jpeg')` 预检，模型不支持时手动工具返回明确错误、自动观察直接跳过，而不是静默降级。

## 许可证

MIT
