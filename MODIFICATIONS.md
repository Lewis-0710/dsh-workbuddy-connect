# DSH WorkBuddy Connect 本地定制与修改记录

本文档用于完整记录本仓库所有相对于上游官方仓库（`upstream`）的本地定制化修改。在后续从上游拉取更新或同步合并时，请务必参考本文档，确保本地修改不被覆盖或遗漏。

---

## 一、分支管理与同步策略

1. **分支职责规范**：
   - `main` 分支：**纯净跟踪分支**，始终严格与上游官方仓库（`upstream/main`）保持 100% 同步，**严禁**在 `main` 分支上直接进行任何本地定制修改或提交。
   - `custom` 分支：**本地定制分支**，所有本地业务适配、UI 调整及功能优化均提交至此分支。
2. **上游同步机制**：
   - 采用 **Patch-First, Smart-Merge** 策略。
   - 每次定制修改完成后，均通过自动同步脚本更新 `sync.patch` 补丁文件。
   - 执行 `./sync.sh` 时，优先使用 `sync.patch` 在最新上游代码上线性应用定制修改；若遇到冲突，则启动智能合并并优先保护本地定制核心文件。

---

## 二、定制修改明细记录

### 修改记录 1：恢复配置入口至「设置 - 插件 - 插件配置」

- **修改日期**：2026-09-26
- **修改目的**：
  上游或历史版本曾将插件配置单独抽取为左侧主菜单一级分区（“设置 - 插件设置”），导致 DSH 设置界面层级混乱。本次修改将入口彻底恢复至原生的「设置 - 插件 - 插件配置」二级卡片（槽位 `settings.plugin.item`）中，移除单独的独立菜单。
- **涉及文件**：
  - `src/client/index.tsx`
  - `src/client/quota-slots.ts`
  - `src/client/http-settings-scope.ts`
  - `lib/client.js` 等编译产物
- **改动详情**：
  1. **移除独立一级菜单**：删除在 `settings.section` 槽位上注册的 `plugin-settings` 分区及其容器组件 `PluginSettingsSection`，删除 `registerPluginSettings` 注册逻辑与常量定义。
  2. **清理多余插槽声明**：在 `src/client/quota-slots.ts` 中移除针对 `'plugin-settings.item'` 的 SlotMap 扩充声明。
  3. **恢复原生插件配置插槽**：保留并确保 `ctx.slots.inject('settings.plugin.item', ...)` 将统一配置卡片 `WorkBuddyPluginCard` 注册在原生插件配置区（key 为 `'workbuddy'`，priority 为 10）。
  4. **修复作用域类型引用**：在 `src/client/http-settings-scope.ts` 中修正 `SettingsScope` 类型引用来源，避免循环和丢失引用。
  5. **重新编译打包**：执行 `pnpm run build`，更新 `lib/` 目录下最新的客户端打包脚本，并通过单测验证。

---

### 修改记录 2：插件自有配置本地原子读写（OwnQuotaSettingsScope）与每日福利自动签到

- **修改目的**：
  - 避免 DSH 0.1.7 中宿主 `configForms` 写配置时触发整树 reconcile 和长时间热重载，提升配置写入速度与稳定性。
  - 支持每日福利自动签到调度与日志面板展示。
- **涉及文件**：
  - `src/client/http-settings-scope.ts`
  - `src/settings-store.ts`
  - `src/client/index.tsx`
  - 签到相关服务与测试
- **改动详情**：
  - 引入自有文件配置存储与 loopback HTTP 读写层，将插件配置直接持久化在用户的 profile 独立目录中，实现毫秒级原子写入。

---

### 修改记录 3：恢复 Host 端命名空间注册，解决插件配置页面卡片不可见问题

- **修改日期**：2026-09-26
- **修改目的**：
  在将客户端入口切回「设置 - 插件 - 插件配置」（`settings.plugin.item`）后，DSH 原生配置页组件（`ConfigurablePluginsTab`）基于“两账本交集（intersection）”原理运行：它仅渲染其 `key` 存在于宿主 `served namespaces` 列表中的卡片。此前重构由于移除了 `installSection` 导致宿主未宣告 `workbuddy` 命名空间，前端将其误判为未接入而过滤。
- **涉及文件**：
  - `src/index.ts`
  - `lib/index.js`
- **改动详情**：
  - 在 `src/index.ts` 的 `ctx.inject(['settings'], ...)` 中恢复通过 `settings.installSection` 注册 `WORKBUDDY_SETTINGS_NS`（`workbuddy`）、`WORKBUDDY_AI_SETTINGS_NS` 与 `WORKBUDDY_QUOTA_SETTINGS_NS`。
  - 数据写入仍然完全走自有文件存储（`SettingsStore`），不触发宿主配置重构或客户端热重载，既满足了 DSH 原生插件配置卡片的显示过滤条件，又保留了毫秒级保存的优势。

---

## 三、后续更新上游代码指南

当上游仓库发布新版本或更新时，请按照以下标准流程操作：

1. **一键自动同步（推荐）**：
   在仓库根目录执行：
   ```bash
   ./sync.sh
   ```
   或者在顶层统一目录执行：
   ```bash
   ./sync-all.sh
   ```

2. **手动合并步骤（备用）**：
   ```bash
   # 1. 获取上游最新代码
   git fetch upstream

   # 2. 保证 main 与上游一致
   git checkout main
   git merge upstream/main --ff-only

   # 3. 切回 custom 分支并重置或合并
   git checkout custom
   git merge main

   # 4. 若出现冲突，保护以下关键定制文件：
   #    - src/client/index.tsx（保留 settings.plugin.item 注册）
   #    - src/client/quota-slots.ts
   #    - src/client/http-settings-scope.ts
   #    - MODIFICATIONS.md（保留本文档）
   #    - sync.sh 与 sync.patch

   # 5. 重新编译与测试
   pnpm run build
   pnpm vitest run tests/client-fallback.spec.ts tests/slot-registration.spec.ts tests/version.spec.ts

   # 6. 重新生成 patch
   git diff upstream/main...custom ':!sync.patch' ':!sync.sh' ':!MODIFICATIONS.md' > sync.patch
   ```

3. **核心原则**：
   - 任何情况下不要向 `main` 分支提交本地改动。
   - 每次完成功能性或界面微调后，请在本文档中追加一条修改记录，并同步更新 `sync.patch`。
