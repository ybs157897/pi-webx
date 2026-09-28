# 代码开发中的 web-idea 接入

代码开发模块把同级 `web-idea` 的 React/Monaco 页面嵌入工作台。pi-webx 后端在 `/api/codes/ide/` 提供其静态产物，并代理 Go gateway 的文件与导航 API。两个仓库保持独立；`PI_WEBX_WEB_IDEA_DIR` 可指定其他绝对或相对位置，默认是 `pi-webx` 同级的 `web-idea`。

先运行 `npm run setup:web-idea`。脚本在 `web-idea/apps/web` 安装锁定依赖并以 `/api/codes/ide/` 为 base 构建，在 `web-idea/.local/bin/web-idea-gateway` 构建 Go gateway。静态资源缺失时状态接口返回 `ready:false` 和构建提示。服务启动时不会启动 gateway；只有用户进入代码开发并调用 `POST /api/codes/ide/start`，或使用代理 API，才按需启动。子进程监听随机 `127.0.0.1` 端口，私有随机 token 只在 pi-webx 进程内，关闭 pi-webx 时一并停止。

| 路径 | 行为 |
| --- | --- |
| `GET /api/codes/ide/config` | `{gatewayUrl:'/api/codes/gateway', token:'', embedded:true, defaultRoot:<代码 Agent 的有效工作区>}`；配置不可用时 503，不暴露私有 token |
| `GET /api/codes/ide/status` | 检查静态产物与 gateway 二进制是否存在，返回 `{ready,error?}`；无启动副作用 |
| `POST /api/codes/ide/start` | 懒启动 gateway 并等待 `/healthz`；成功 `{ready:true}`，失败 503 `{ready:false,error}`；重复调用复用进程 |
| `/api/codes/ide/` | web-idea 静态页面及 Vite 产物 |
| `/api/codes/gateway/api/v1/...` | 同源 HTTP 代理到 gateway 的 `/api/v1/...`，转发 JSON 或文本文件请求体及上游状态 |
| `/api/codes/gateway/api/v1/workspaces/:id/lsp` | 仅此形态允许 WebSocket upgrade，双向转发 JSON-RPC 帧 |

HTTP/WS 代理只允许固定 gateway API 路径，跨站 Origin 拒绝；上游的 Bearer token 由服务端加到请求。WS 桥先完成上游握手再接受浏览器连接，防止初始化帧丢失。gateway 自己继续负责工作区根目录与路径沙箱。嵌入页的编辑器、目录树、快速导航和可用时的 Java LSP 都使用这些 API。LSP 需要额外配置 `WEBIDEA_JDTLS_LAUNCH`，普通文件编辑和导航不依赖它。Node 在独立进程组中启动 gateway，关闭时终止该进程组，以释放可能启动的 jdtls 子进程。当前范围不包括在页面内执行项目构建。

验收运行 `npm run check:codes-ide`：在临时工作区通过真实 Go gateway 验证懒启动、文件读写、路径越界、跨站请求与关闭释放；延迟握手的 WS 回声 fixture 验证首帧不丢，进程组 fixture 验证子进程随 gateway 释放，端口预留 fixture 验证关闭与启动并发时不会产生新进程。完整集成还需工作台 UI 门禁和浏览器验收。


工作区目录统一维护在 `config/agents/codes.yaml` 的 `workspace`。进入代码开发菜单后，嵌入页自动发送 `web-idea:open-request`，父页只 GET codes settings 并返回当前 `workspacePath`，再由编辑器创建 Gateway 工作区；不会通过 IDE 改写绑定，也不使用消息携带的其他目录。嵌入模式没有目录选择表单或关闭项目入口；目录不可用时显示错误、配置页引导和重试按钮。更换目录统一在 Agent 配置页完成，重新进入代码开发会打开新目录。`web-idea:state` 仅接受来自当前 iframe 的同源消息；右侧代码 Agent 以该目录创建或恢复对话。新会话必须匹配当前绑定，历史会话始终保留原目录，浏览器会话指针和草稿按项目隔离。独立运行 web-idea 时仍保留原来的项目选择界面。

桌面编辑器与最右侧对话各自滚动；900px 以下保留两个面板，通过编辑器/代码对话按钮切换。原 SQLite 开发事项仍从工具栏进入。离开代码模块时，若 iframe 报告未保存或正在保存，阻止导航并提示先保存；正常离开释放 Gateway 工作区。嵌入聊天使用非模态 region，Esc 不会关闭固定面板。

2026-09-28 验收：工作台/SSR UI/typecheck/module-agents 全通过，全量 `npm run check` 通过；新增 IDE 网关与绑定门禁通过。使用独立临时配置、SQLite 和两份临时项目，在浏览器验证 Monaco 修改与保存到磁盘、Go to File 打开 README、代码 Agent 实际通过 read 工具读取已保存内容、切换第二项目不显示第一项目会话、切回恢复原会话。后续按用户要求改为只读配置并自动打开：首次进入打开配置项目 A，配置切到 B 后重新进入自动打开 B，配置 revision 保持不变；目录失效显示错误与配置页引导，恢复目录后重试成功，页面不出现目录选择框。1440px 桌面编辑器与右栏无重叠，390px 可切换编辑器/对话且无横向溢出，输入区保持在底部导航上方。Java jdtls 语义跳转未配置，因此本次仅验证文件导航；页面不提供构建运行。
