# Changelog

## 0.3.0

短期观察记忆（short-term observation memory）：

- 新增 `src/memory.ts` 纯内存记忆管理：按场景（同一本书 / 视频 / 项目）分组，支持容量限制（最多 3 场景、每场景最多 5 条，合计最多 15 条）、同一截图去重、按真人回合数 / 时间过期。
- 新增三个工具：`screen_companion_memory_record`（写摘要）、`screen_companion_memory_recent`（读当前场景摘要）、`screen_companion_memory_clear`（清空）。
- 记忆只保存在内存中、重启清空，不保存原始截图；所有记忆内容只来自对既有截图与相关对话的视觉理解，不确定处要求模型用「可能/似乎」表达、不把猜测写成确定事实。
- 观察回执与 `screen_companion.observed` 事件正文自动附上近期摘要，帮助桌宠连续接续同一本书 / 视频 / 项目。
- 新增 5 个配置项（`shortMemoryEnabled`、`memoryMaxTurns`、`memoryTtlMinutes`、`memoryMaxEntriesPerScene`、`memoryMaxScenes`），在独立的「短期记忆」配置页中管理，与「截图与观察」配置页分开。
- 轮数统计按宿主轮次信号近似（自动观察、内部事件、工具调用不计入）；场景切换纯靠模型提供的 `sceneType` / `sceneLabel` 标签。
- 新增 `tests/memory.test.ts` 与 `tests/world.test.ts` 中的记忆集成测试。

## 0.1.0

首个 MVP：

- 新增 `screen_companion_look_now` 工具：截取当前屏幕并把截图作为图片附件交给宿主多模态模型，可携带用户问题。
- **自动观察**：按 `captureIntervalMs` 定期截屏，画面哨兵（降采样逐像素比对）检测到明显变化时，通过 `pushEvent` 把截图作为 `screen_companion.observed` 事件主动推给模型，桌宠无需用户说话即可开口。
- 可配置自动观察开关、轮询间隔（截屏频率）、画面变化阈值、活跃度、显示器与截图最大宽度。
- 新增「活跃度」参数（安静 / 适中 / 活跃）：注入环境提示词调节主动开口的频繁程度。
- 新增「推送冷却」参数（`pushCooldownMs`）：两次把截图交给模型之间的最小间隔，默认 20 秒，可独立调节。
- 默认主显示器，多屏可配置显示器 id；截图超宽时等比缩小（默认最大 1920px）。
- 新增「自定义截图区域」：新增 `screen_companion_select_region`（弹出全屏遮罩，鼠标拖拽框选矩形，Esc 取消）与 `screen_companion_clear_region`（恢复全屏）两个工具；新增「全屏 / 自定义区域」截图模式 `captureMode` 与区域坐标 `region`，自动观察、画面变化检测与手动截图统一按当前模式截取。截屏进程加 `SetProcessDPIAware`，框选坐标与像素坐标一致。
- 模型无法处理图像或截图失败时返回明确失败回执；自动观察在模型不支持图像时跳过。
- 截屏走 Windows 自带的 PowerShell + .NET `System.Drawing`，无第三方二进制、无 csc.exe 编译。
- 环境提示词说明截图语义（一次观察，不代表完整阅读历史）与自动/手动两种触发方式。
- 附 describe.json 自描述、类型检查与基础自动化测试。
