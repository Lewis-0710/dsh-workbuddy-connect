# DSH WorkBuddy Connect


[English](./README.en.md) | 中文


将 WorkBuddy 的模型（GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3、Hy3 等）接入 DeepSeek Harness，在 DSH 对话窗口里直接使用。

国内版 **WorkBuddy** 与国际版 **WorkBuddy AI** 同时支持：登录哪一版就出现哪一版的分组，两版都登录就两组并存，各自用自己的账号与积分。

**插件自己完成登录**，不需要安装 WorkBuddy 桌面 App：在设置卡片点「登录」，或在终端运行 `dsh-workbuddy-connect login`，在浏览器里完成授权即可。已有 `workbuddy.json` 的用户也可以直接导入。


## 功能

- **登录即用**：安装后在卡片上登录一次，模型分组立刻出现；之后访问令牌自动续期，无需再管。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **国内版与国际版并存**：国内版显示为「WorkBuddy」分组，国际版（WorkBuddy AI）显示为「WorkBuddy AI」分组。两版的模型、账号和积分互不混用。**两版各自独立登录**：只登录国际版就只出现「WorkBuddy AI」，两版都登录就两组都在，退出其中一版则对应分组消失。设置里也是**两张卡片**，分别展示各自的账号、余额与登录按钮。

![WorkBuddy AI 模型出现在 DSH 模型选择器中](assets/5.png)


- **图片输入**：大部分模型支持发图，在对话里直接粘贴或拖入图片即可（GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）；少数只支持文字的模型（如 GLM-5.1）会明确提示不支持。


- **推理档位**：WorkBuddy 明确声明的档位会直接显示，例如 GLM-5.3 和 GLM-5.3-Flash 可选 low / high / max。对于部分没有声明可选档位的模型，Web 和 Desktop 可在模型选择器中点击「推理等级」手动检测；检测会发送少量请求，可能消耗积分。未检测或没有可用档位的模型仍使用 WorkBuddy 的默认档位。


- **信息查看与检测**：设置 → 插件 → 对应卡片可查看账号、令牌有效期、剩余积分和模型优惠；也可以手动刷新模型列表，并在卡片上看到当前列表来自上游还是内置兜底。对于可检测模型，也可以在这里手动检测推理档位。

- **企业账号积分**：国内版企业账号（`enterpriseId` 非空）走企业专用计费接口读取周期额度，卡片显示「企业额度」与周期重置时间。

- **费率比例**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到。倍率只是显示，不影响实际请求。


- **徽章展示**：促销徽章（限时免费、夜间折扣）直接跟在模型名后面（如 `Hy4 preview · x0.00 · 限时免费`），选模型时一眼可见；设置卡片里也会汇总当前有优惠的模型。以 WorkBuddy 服务端的数据为准，每次启动 DSH 时同步。国际版的促销来自服务端的 `modelPromotions`（含生效时段）：促销过期后徽章会撤销；由于服务端把折后价直接写在模型的倍率字段里，原价无法还原，此时该模型的倍率会显示为「价格未知 — 刷新后更新」，而不是继续显示折扣价或「免费」。

![设置卡片显示插件](assets/2.png)

卡片展开后分为「状态 / 上下文 / 明细」三个标签：状态页展示账号、令牌有效期、合计积分、模型列表来源与推理档位检测；上下文页列出各模型的上下文窗口。国际版在上游声明了更大可选窗口时，可在这里切换「使用上游声明的最大上下文窗口」；该开关**默认开启**，DSH 会按上游声明的最大窗口安排上下文压缩；想改用上游的默认窗口就在这里关掉，偏好会持久化，重启后保持。明细页展示各套餐余量与模型优惠。国内版与国际版各有一张自己的卡片，各显示自己账号的信息。

![设置卡片显示账号与剩余积分](assets/3.png)

## 推理档位为什么这样设计

WorkBuddy 中模型的推理档位信息目前分散在上游接口与客户端自身的私有 UI 逻辑中，且模型目录变化很快。若插件根据经验为所有未声明模型补齐统一档位，就需要持续追赶这些未公开、没有稳定契约的产品逻辑。

![设置档位](assets/4.png)


实测还发现，有些模型虽然接受 `reasoning_effort` 参数，却可能忽略未知值并回退到默认行为；一次请求返回成功，并不能证明某个档位真实可用。

因此，对于没有声明档位的模型，Web 和 Desktop 采用用户主动授权触发、动态获取档位的方式：先确认上游会校验该参数，再逐项确认哪些规范档位被接受。检测会发送少量请求，可能消耗积分；结果只表示当前上游接受该档位，不承诺它一定改变推理效果、速度或积分消耗。

## 从 0.5.x 升级到 0.6.0（重要）

**0.6.0 改变了凭据的来源，是一次破坏性升级，请先读完这一段。**

| | 0.5.x（旧） | 0.6.0（新） |
|---|---|---|
| 凭据来源 | 读 WorkBuddy 桌面 App 写的本地 auth 文件 | **插件自己登录**（设备授权流程） |
| 是否要装桌面 App | 要 | **不要** |
| 凭据位置 | `$DSH_HOME/.workbuddy-auth.json` | `$DSH_HOME/profiles/<profile>/.dsh-workbuddy-connect/` |
| 设置项 `authFile` / `authFileAI` | 有 | **已移除** |

升级后你需要**重新登录一次**，旧的文件不会被读取：

```sh
# 卡片上点「登录」，或：
dsh plugin --profile web exec dsh-workbuddy-connect login
```

**已有 `workbuddy.json`？** 可以不必走浏览器，直接导入即可（卡片上的「选择文件…」，或 `import --file`）。格式与旧文件完全一致，`expiresAt` 为**秒**：

```json
{
  "auth": { "accessToken": "…", "refreshToken": "…", "expiresAt": 1794051445, "domain": "copilot.tencent.com" },
  "account": { "uid": "…", "nickname": "…" },
  "region": "cn"
}
```

导入时会校验区域：把国际版凭证导给国内版会被拒绝，并提示该用哪个 `--provider`。

## 安装

前置：无需安装 WorkBuddy 桌面 App。插件自己完成登录——在设置卡片里点「登录」，或在终端运行 `dsh-workbuddy-connect login`，浏览器完成后凭据即写入插件自己的文件。国内版与国际版各自独立登录，互不影响。

**版本对应（重要）**：本插件与 DSH 核心版本一一对应，不可混用——不匹配的组合会导致 DSH 启动失败：

| 插件版本 | 要求的 DSH 核心 | 桌面 App |
|---|---|---|
| **0.6.0+** | `0.1.5-rc.1` 及以上 | 不需要 |
| **0.3.2 – 0.5.x**（国际版支持自 `0.5.0`） | `0.1.5-rc.1` 及以上 | `2.0.7`+（内置核心已跟进 `0.1.5-rc.1`） |
| **0.3.0 – 0.3.1** | `0.1.2-rc.1` | `2.0.5` |
| **0.2.6** | `0.1.1-rc.2`（旧线） | `2.0.3` / `2.0.4` |

- 需要 DSH `0.1.5-rc.1` 及以上。`0.3.2` – `0.5.x` 那几个版本以桌面 App 内置核心为准；本版不再依赖桌面 App。
- 本仓库从 GitHub 安装，安装时会构建；仓库已提交 `lib/` 预构建产物，无需本地构建。

插件在三种 DSH 界面下均可运行：**Web**、**Desktop**、**TUI**。根据你使用的 profile 选对应命令安装。

```sh
# Web（推荐）
dsh plugin --profile web add github:masknull/dsh-workbuddy-connect
dsh web
```

```sh
# Desktop（DSH Desktop 桌面版）
dsh plugin --profile desktop add github:masknull/dsh-workbuddy-connect
dsh --profile desktop
```

```sh
# TUI（终端界面）
dsh plugin --profile dsh-tui add github:masknull/dsh-workbuddy-connect
dsh --profile dsh-tui
```

需要某个具体版本时用 tag 指定，例如 `github:masknull/dsh-workbuddy-connect#v0.6.0`。

> **TUI 用户请注意版本搭配**：终端界面插件 `@deepseek-harness-tui/dsh-tui` 需要 **`0.10.0-beta.5` 及以上**（更早的版本装了本插件会启动失败，报 `events is not iterable`）。请先用 TUI 自带的更新方式把壳升到 beta.5 及以上，再安装本插件；当前最新的是 beta 版，正式版发布后同样可用。

> 推理档位的手动检测入口目前仅提供给 Web 和 Desktop；TUI 不提供检测操作。

> 提示：`dsh-tui` profile 需用 pnpm 11 安装（PATH 里是其他版本会报 `ERR_PNPM_UNEXPECTED_STORE`，用 `npx pnpm@11` 即可）。

安装后，在对应界面的模型选择器里切换到 WorkBuddy 模型即可使用。Web 和 Desktop 下，设置卡片可查看账号信息、令牌有效期与剩余积分，手动刷新模型列表，并手动检测符合条件模型的推理档位。**未登录时**卡片提供「登录」（打开浏览器完成授权后自动生效）与「选择文件…」（导入已有的 `workbuddy.json`）；**已登录时**提供「切换账号」（丢弃当前凭据并立即重新登录）与「退出登录」。国内版与国际版各有自己的卡片，各自独立登录。

## 命令行

`dsh plugin --profile <web|desktop|dsh-tui> exec dsh-workbuddy-connect login`：在浏览器中完成登录（打印授权链接，完成后自动写入凭据）。适用于没有浏览器卡片的环境，如 TUI。

`dsh plugin --profile <web|desktop|dsh-tui> exec dsh-workbuddy-connect import --file <path>`：导入已有的凭证文件（格式同 `workbuddy.json`）。`--file -` 从标准输入读取，便于管道传入。

`dsh plugin --profile <web|desktop|dsh-tui> exec dsh-workbuddy-connect status`：登录状态与剩余积分（`--json` 输出机器可读格式；另有 `doctor` 诊断、`logout` 清理凭据）。

默认操作国内版；加 `--provider workbuddy-ai` 操作国际版：

```sh
dsh plugin --profile web exec dsh-workbuddy-connect login --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect import --provider workbuddy-ai --file ./workbuddy-global.json
dsh plugin --profile web exec dsh-workbuddy-connect status --provider workbuddy-ai
dsh plugin --profile web exec dsh-workbuddy-connect doctor --provider workbuddy-ai
```

### 凭证存放位置

按 profile 隔离，放在 `$DSH_HOME/profiles/<profile>/.dsh-workbuddy-connect/` 下（默认即 `~/.dsh/profiles/web/.dsh-workbuddy-connect/`）：

| 文件 | 对应 |
|---|---|
| `.workbuddy-auth.json` | 国内版 |
| `.workbuddy-ai-auth.json` | 国际版 |

**profile 目录怎么确定的**：DSH 没有把当前 profile 名暴露给插件，所以插件会在 `$DSH_HOME/profiles/` 下找**声明了本插件的 profile**（读各 profile 的 `package.json`）；若有多个都声明了，再用"该 profile 里安装的这份插件是否指向当前这份代码"来消歧。这样 web / desktop / tui 各自独立、互不干扰。

若一个都确定不了（例如直接从源码 checkout 运行），回落到 `$DSH_HOME/.dsh-workbuddy-connect/`；环境变量 `DSH_WORKBUDDY_DATA_DIR` 可显式覆盖。

每个目录下只有凭证 `.json` 本身，**没有 `.lock` 或临时文件残留**（写入用临时文件 + rename 原子替换）。

`logout` 只删除对应版本自己的那个文件，不影响另一版。

## 已知限制

- **本版验证环境**：Windows + DSH Web。已验证真实登录（国内版与国际版都能取到授权链接，轮询状态正确）、`workbuddy.json` 导入、两版账号与积分各自独立读取；设置卡片在折叠/悬停/展开各状态下与 DSH 内置卡片逐属性样式一致。其余平台未在本版复跑。
- 要求 DSH `0.1.5-rc.1`+、Node 22+；TUI 需终端界面插件 `0.10.0-beta.5` 及以上（见安装章节）。凭据由插件自己登录获得，与 WorkBuddy 桌面 App 是否安装、装在哪里都无关。
- **国际版登录在部分网络下不可达**：`www.workbuddy.ai` 在国内部分网络无法访问，此时国际版登录会失败并报出原因，国内版不受影响。
- **国际版的模型目录来自 App 界面接口**：服务端按 User-Agent 分流下发，属私有实现，上游改动可能使其失效。届时插件按「本账号上次成功目录 → 内置目录」降级，并在卡片上标明来源（实时 / 已保存 / 内置）、更新时间与失败原因，但不能保证长期兼容。国内版目录走官方 CLI 同款接口，不受此影响。
- **国际版目录的 User-Agent 版本**：Windows / WSL / Linux 下读不到国际版 App 的版本，会退回最近保存的版本或内置值；这与登录无关，登录不依赖桌面 App。
- **无凭据时的行为**：某一版从未登录过时，该版模型分组不显示——此时该版没有可用凭据，列出模型只会让每一次调用都失败。登录后分组立即出现。
- **企业账号积分目前仅覆盖国内版**：国际版企业账号的计费接口尚未验证，仍按个人版接口读取；待有实测结论后再扩展。企业账号分支在本机无法自测（开发机为个人账号），依据官方 App 的接口契约实现，欢迎企业账号用户反馈实测结果。
- 依赖 WorkBuddy 客户端接口（非官方开放 API），WorkBuddy 更新后插件可能需要随之调整。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。0.6.0 的登录流程与上游调用（请求头、请求体改写、端点选择、错误分类）均以该实现为准。
- [zqcccc/workbuddy-cliproxy](https://github.com/zqcccc/workbuddy-cliproxy) — 设备授权登录流程的早期参照。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — 本仓库的上游。

## 许可证

[MIT](./LICENSE)
