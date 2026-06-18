# 1.7.27 - 2026-06-18

- 按用户要求完全恢复时间顺序第三次提交 `03c7e2b` 中的 `zhihu-auto-scroll.js`，不再保留后续自行调整的评论入口逻辑。
- 当前 `zhihu-auto-scroll.js` 与 `03c7e2b:zhihu-auto-scroll.js` 对比无差异。

# 1.7.26 - 2026-06-18

- 修复上一版评论入口最近点击记录保留过久导致真实页面看起来“评论打不开”的问题：改为短期记录当前评论入口 owner，只用于归属延迟出现的 Modal。
- 评论入口 pending 现在只会短等有限轮数，超出后继续滚动扫描后续回答，避免第一条评论入口未完成时卡住整页。
- 修复延迟出现的评论 Modal 会让第一条评论入口 pending 卡住的问题：点击后若短时间内还没弹窗，会保留短期 owner 用来认领随后出现的 Modal；等 Modal 真正关闭后再完成对应入口，避免后续回答评论不再打开。
- 按时间顺序第三次提交 `03c7e2b` 恢复评论入口 pending 打开逻辑：入口点击后会继续跟踪并重试，直到内联评论区出现、按钮变为 `收起评论`，或弹出评论 Modal 后完成处理。
- 恢复 `pendingCommentEntries`、点击前 dialog 快照和最近点击入口记录，用于等待评论 DOM 追加，避免评论入口点击后过早标记完成。
- 待打开评论入口会保持短等待和重试节奏，不再因为两轮评论等待上限提前滚动跳走；`comment-entry` 也恢复使用评论专用重试次数。
- 保留当前 `添加评论` 入口识别、auth/login/security/captcha 阻断判断，以及评论 Modal 出现后关闭的策略。

# 1.7.25 - 2026-06-18

- 修复部分知乎回答底部评论入口显示为 `添加评论` 时不会被点击的问题；入口识别现在同时支持 `添加评论`、`N条评论` 和 `打开 N 条评论`。
- 继续沿用底部位置约束，只点击答案内静态 `.ContentItem-actions`，页头/问题头部和 fixed/sticky 浮动操作栏里的 `添加评论` 不会误触。
- 更新本地 smoke fixture 和单元测试，覆盖 `添加评论` 的有效入口、头部干扰项、fixed 操作栏干扰项，以及原有评论 Modal 关闭策略。

# 1.7.24 - 2026-06-18

- 重构评论入口打开逻辑：删除 `commentOpenState`、评论入口 Modal 认领、入口 pending/retry 等状态机，不再为答案底部评论入口做多轮等待和重试。
- 答案底部 `N条评论` / `打开 N 条评论` 现在只点击一次；点击后短等 400ms，若出现非登录/验证类 dialog 或 Modal 就立即关闭，未出现弹窗则按内联评论区继续滚动和增量扫描。
- 保留回答展开、加载更多回答，以及评论区内部 `查看全部/展开其他/查看更多` 回复和评论分页按钮的展开逻辑；auth/login/security/captcha 弹窗仍优先触发 `auth-blocked` 暂停。
- 更新本地 smoke fixture：覆盖评论入口打开 Modal 后关闭并继续滚动、内联 `.Comments-container` 继续展开回复/更多评论、auth 弹窗阻断。

# 1.7.23 - 2026-06-18

- 修复 `zhihu archive --comments` 在评论 Modal 中出现普通 `登录后...` 文案时误判为登录态失效的问题。
- auth 弹窗识别改为依赖 SignFlow/Login/Captcha 结构、密码/手机号表单、验证码/安全验证/人机验证等强信号；评论 Modal 内的普通登录提示不再阻断归档。
- 本地 smoke fixture 增加评论 Modal 内登录提示文案，确保 `162条评论` 延迟弹窗仍会被认领并继续展开回复/更多评论。

# 1.7.22 - 2026-06-18

- 重构评论入口打开流程：新增显式 comment-entry 打开状态，集中记录当前入口、点击前 dialog 快照、等待截止时间和已认领评论 Modal，不再依赖多个 Set 间接推断。
- 评论入口点击后会持续等待内联 `.Comments-container`、本次点击产生的新评论 Modal，或按钮变为 `收起评论`；异步插入的评论 Modal 会被视为成功打开并继续扫描其中的回复/更多评论按钮。
- 将旧评论弹窗清理与本次点击 Modal 认领拆开：只清理点击前已存在且不是当前认领对象的旧评论弹窗，登录/验证/安全弹窗继续优先触发 `auth-blocked` 暂停。
- 增加本地 smoke 覆盖：延迟 300ms 插入评论 Modal、旧评论 Modal 清理、auth dialog 阻断、内联评论容器继续展开。

# 1.7.21 - 2026-06-18

- 修复 `162条评论` 这类评论入口打开 `.Modal-content` 后被立即当成 unexpected dialog 关闭的问题。
- 评论入口打开的新评论 Modal 现在会被视为当前评论容器，并继续处理其中的 `查看全部 N 条回复`、`点击查看全部评论` 等展开按钮。
- 评论 Modal 延迟插入时会继续保留当前入口的等待状态，避免第一次没等到 Modal 后又在下一轮把它当旧弹窗关闭。
- 保留登录、验证、安全弹窗的阻断暂停逻辑；启动前遗留的旧评论弹窗仍会被清理。

# 1.7.20 - 2026-06-18

- 修复知乎评论区回复展开按钮识别不完整的问题：除 `展开其他 N 条回复` 外，现在也识别 `查看全部 N 条回复`、`展开全部 N 条回复`、`查看更多 N 条回复`。
- 修复评论面板内部的评论分页按钮未继续点击的问题：现在会识别 `点击查看全部评论`、`查看全部 N 条评论`、`查看更多 N 条评论`、`展开更多评论`。
- 增加真实知乎评论/回复按钮文案的单元测试和冒烟测试覆盖，避免评论面板已打开但评论列表或回复楼层没有继续展开。

# 1.7.19 - 2026-06-18

- 修复 `zhihu archive --comments --url <url>` 这类顺序下评论开关可能未按预期启用的问题：参数解析器现在显式识别 `--comments`、`--open-comments` 等布尔开关，不再依赖相邻 token 猜测。
- 评论开关支持 `--comments=true` / `--comments=on` 等等号写法，`--comments=false` 会保持关闭。
- 增加参数顺序和布尔开关归一化测试，防止评论归档开关再次回归。

# 1.7.18 - 2026-06-18

- 撤回浏览器最小化后继续归档的支持代码，不再通过后台节流参数、CDP lifecycle keep-alive 或自动化 hidden 例外强行推进页面。
- 最小化/hidden 场景回到暂停等待恢复的行为，避免在 Chrome/Edge 最小化导致页面渲染和懒加载不可用时继续保存半成品。
- 删除最小化/hidden 继续归档相关测试，保留普通后台暂停语义。

# 1.7.17 - 2026-06-18

- 修复 `zhihu archive --comments` 在浏览器窗口最小化后很快结束并保存半成品的问题：自动化页面 hidden 时不再把无进展累计为 `idle-timeout`。
- 归档期间通过 CDP 周期性设置页面生命周期为 `active`，降低 Chrome/Edge 最小化后冻结归档页的概率。
- 增加页面生命周期 keep-alive 和 hidden 自动化空闲判定测试。

# 1.7.16 - 2026-06-18

- 确认并测试 `zhihu archive --comments --url <url>` 参数顺序，`--comments` 可以放在 `--url` 前后。
- 问题页 URL 归一化现在会移除 hash fragment，例如 `https://www.zhihu.com/question/286130359#CTZ_DEFAULT` 会解析为 `https://www.zhihu.com/question/286130359`。

# 1.7.15 - 2026-06-17

- 修复 `zhihu archive` 在浏览器窗口不在前台时停止推进的问题：Playwright 注入的自动化模式不再因为 `document.hidden` 暂停滚动。
- 原生 Chrome/Edge 归档会话新增后台节流禁用参数，降低窗口被遮挡或切到后台时定时器被浏览器降频的概率。
- 增加隐藏页面下自动化归档仍继续滚动的冒烟测试，并保留普通用户模式后台暂停行为。

# 1.7.14 - 2026-06-17

- 移除页面上的知乎展开控制面板、展开小按钮、隐藏按钮、拖动逻辑和相关样式；userscript 不再向页面插入任何控制按钮。
- 自动展开仍通过 `window.zhihuAutoExpand` 自动化 API 由 Playwright 调用，`snapshot.status` 保留运行状态，速度、间隔和评论开关继续支持脚本配置。
- Playwright 冒烟测试改为直接调用自动化 API，并新增断言确认页面不存在旧面板和按钮。

# 1.7.13 - 2026-06-17

- `zhihu archive --url` 现在支持 `https://www.zhihu.com/question/<id>/answer/<answer-id>` 格式，会自动归一化为对应的问题页 URL。
- 增加 answer URL 解析测试，确保归档目标不会保留 `/answer/...` 路径。

# 1.7.12 - 2026-06-17

- 修复归档 HTML 在浏览器中打开后可能自动刷新/跳转的问题：SingleFile 保存阶段强制阻断页面脚本，并插入 CSP，让输出文件保持静态归档。
- 增加 SingleFile 保存参数测试，防止后续误把 `blockScripts` 或 `insertMetaCSP` 关掉。

# 1.7.11 - 2026-06-17

- 修复 `zhihu archive --comments` 可能长期停在首批回答进度的问题：评论展开等待现在有上限，超过后会继续页面滚动，避免阻塞知乎加载后续回答。
- 回答进度统计在每轮归档循环结束前会重新扫描当前 DOM，并按回答 ID 去重，避免 MutationObserver 漏掉已加载回答时进度滞后。
- 增加回答节点收集和评论等待让出滚动的单元测试。

# 1.7.10 - 2026-06-17

- 默认归档文件名改为 `archives/<question-title>.html`，不再包含 `zhihu-question`、问题 ID 和时间戳。
- 归档标题会清理知乎页签里的私信/消息前缀，例如 `(81 封私信 / 9 条消息)`，只保留问题标题。
- `zhihu archive` 第 5 步改为在当前已展开页面内直接运行 SingleFile 并分块写入 HTML，不再重新打开第二个页面、重复滚动展开或因为第二轮展开看起来卡住。

# 1.7.9 - 2026-06-17

- `zhihu`、`zhihu login`、`zhihu auth-check`、`zhihu archive` 的命令行 help、运行日志、错误提示和归档摘要统一改为英文输出。
- `zhihu archive` 的前置上下文继续保持无时间戳，任务阶段、进度、失败和摘要日志继续保留时间戳。
- `zhihu archive` 默认不再设置 `timeout-ms=600000`；`timeout-ms` 默认显示为 `off`，只有显式传入 `--timeout-ms` 时才限制页面自动展开和 SingleFile 捕获时间。
- 保留知乎页面中文按钮、弹窗和验证文案识别逻辑，避免影响自动展开和登录态判断。

# 1.7.8 - 2026-06-17

- `zhihu archive` 的阶段日志、失败日志、结果摘要和批量总结统一增加本地时间戳。
- 进度日志中 `空闲轮次` 只有大于 0 时才显示；`0` 不再展示。
- `zhihu archive` 和 `zhihu auth-check` 改用一次性临时浏览器 profile，并注入保存的 storageState，避免登录 profile 被残留 Chrome 进程锁住后 DevTools 端口启动失败。
- `zhihu archive` 开头集中打印任务、URL、目标数量、浏览器和关键参数，并保持无时间戳；后续阶段/进度/错误/摘要日志带时间戳且不再重复问题 ID 和评论开关。

# 1.7.7 - 2026-06-17

- 归档进度日志增加本地时间戳，格式如 `[00:12:34] [286130359] 当前进度：5/504`。
- 同一个回答进度只输出第一次，不再因为长时间停留在 `5/504` 而重复刷相同日志。
- 评论模式在每轮开始时增加评论弹窗兜底关闭，处理点击后延迟出现的知乎评论 Modal；原有点击后立即关闭逻辑保留。

# 1.7.6 - 2026-06-17

- 将全局 CLI 收敛为单一入口 `zhihu`，子命令改为 `zhihu login`、`zhihu auth-check`、`zhihu archive`。
- npm `bin` 不再暴露 `zhihu-login`、`zhihu-auth-check`、`zhihu-archive` 三个分散命令。
- 更新主命令和子命令 help、错误提示、示例命令，统一使用 `zhihu <command>` 格式。

# 1.7.5 - 2026-06-17

- `zhihu-archive` 的评论展开参数明确为 `--comments`，并新增同义参数 `--open-comments`；开启后第 3 阶段会显示为“滚动展开并打开评论”。
- 滚动展开阶段增加实时进度输出，周期读取页面脚本 `snapshot.answerCount/totalAnswerCount`，显示形如 `当前进度：1/502`；支持 `--progress-interval-ms` 调整输出间隔。
- 进度输出会标记评论模式和空闲轮次，长页面归档时不再只停在 `3/6 滚动展开`。

# 1.7.4 - 2026-06-17

- 定位并修复登录后 `zhihu-archive` 仍弹登录窗口的根因：`zhihu-login` 保存的 `.auth/zhihu.storageState.json` 里有 `z_c0`，但原生 Chrome profile 中没有同步持久化该 cookie；归档流程此前只复用 profile，未注入 storageState。
- `zhihu-archive` 和 `zhihu-auth-check` 现在启动原生 Chrome/Edge 后会先把 `.auth/zhihu.storageState.json` 的 cookies/localStorage 注入到当前浏览器 context，再打开知乎页面。
- `zhihu-auth-check` 默认改为检查稳定的问题页，并支持 `--url` 指定检查目标，避免知乎首页风控或首页文案导致误判。

# 1.7.3 - 2026-06-17

- `zhihu-archive` 改为复用 `zhihu-login` 创建的原生 Chrome/Edge profile，通过 DevTools 连接真实浏览器会话打开知乎问题页，避免 headless Playwright 触发 `40362 请求存在异常`。
- 修复原生浏览器会话下 userscript 注入被知乎 CSP 拦截的问题：不再使用 `page.addScriptTag`，改为通过 DevTools evaluate 执行脚本源码。
- 登录态判断改为先识别真实风控/验证页和登录页，不再把问题页里的普通“登录/注册”文案误判为登录失效。
- SingleFile 保存阶段会传入系统浏览器可执行文件路径，并默认用可见系统浏览器捕获页面。
- 自动展开超时和 SingleFile 超时现在分开提示，排查原因更明确。

# 1.7.2 - 2026-06-17

- 将 `zhihu-login` 从 Playwright 控制浏览器改为直接启动本机 Chrome/Edge 可执行文件，并通过临时 DevTools 端口在用户手动登录后读取 storageState，避免知乎登录接口在自动化页面里报 `10001: 请求参数异常，请升级客户端后重试`。
- `zhihu-login --channel chromium` 现在会直接拒绝并提示使用 Chrome/Edge，避免继续走已知失败路径。
- 登录专用浏览器资料会保存到当前目录 `.auth/zhihu-login-<browser>-profile`，方便后续重复登录时复用该正常浏览器会话。

# 1.7.1 - 2026-06-17

- 修复 `zhihu-login` 使用 Playwright Chromium 登录知乎时容易触发 `10001: 请求参数异常，请升级客户端后重试` 的问题：登录默认优先启动本机 Google Chrome，其次 Microsoft Edge。
- `zhihu-login`、`zhihu-auth-check`、`zhihu-archive` 增加 `--channel chrome|msedge|chromium`，必要时可手动指定浏览器。
- 登录、检查和归档统一使用 `zh-CN`、`Asia/Shanghai`、中文 `Accept-Language` 和固定桌面 viewport，减少知乎把自动化上下文识别成异常客户端的概率。

# 1.7.0 - 2026-06-17

- 增加 npm `bin` 入口，支持全局安装后直接运行 `zhihu-login`、`zhihu-auth-check`、`zhihu-archive`，不再要求进入项目目录执行 `npm run`。
- 拆分包目录和运行目录：脚本源码、userscript 和 SingleFile 依赖仍从安装包读取，`.auth/`、`archives/`、`test-results/` 会写入当前命令执行目录。
- 将运行时需要的 `playwright` 和 `single-file-cli` 移到 `dependencies`，避免全局安装后缺少运行依赖。
- 已在本机执行 `npm link`，并验证项目目录外可直接运行 `zhihu-archive --help`。

# 1.6.0 - 2026-06-16

- 新增 `npm run zhihu:auth:check`，会实际用 `.auth/zhihu.storageState.json` 打开知乎并区分登录态过期、登录跳转和验证码/反爬验证。
- `npm run zhihu:archive` 增加 `--help`、`--urls-file`、`--debug-dir`，支持批量归档、阶段化进度输出和 debug 产物保存。
- 归档完成后输出回答数/总回答数、完成状态、自动暂停原因、文件大小、SingleFile 保存耗时和输出路径。
- 默认归档文件名改为读取页面标题后的 `zhihu-question-<id>-<safe-title>-<timestamp>.html`，并对 Windows 不安全字符和长度做清理限制。
- 页面自动化 API 新增 `completionStatus` 和 `completionReason`，归档流程现在区分 `completed`、`idle-timeout`、`auth-blocked`、`error`，不再只依赖 `paused`。
- SingleFile cookies/bootstrap 改为写入唯一 `.auth/zhihu.singlefile.*` 临时目录，并在启动时清理遗留临时目录。
- 验证通过：`npm run check`、`npm test`、`npm run test:smoke`、`npm run zhihu:archive -- --help`；当前本机 `.auth` 已过期，`npm run zhihu:auth:check` 正确提示重新运行 `npm run zhihu:login`。

# 1.5.0 - 2026-06-16

- 新增 Playwright 登录态脚本：`npm run zhihu:login` 以 headed 模式打开知乎登录页，手动确认后覆盖保存 `.auth/zhihu.storageState.json`。
- 新增知乎问题归档入口：`npm run zhihu:archive -- --url https://www.zhihu.com/question/xxxx` 默认 headless 复用登录态，缺少登录态时提示先运行登录命令，并支持 `zhihu:archive:headed` 排查。
- 归档流程会打开目标问题页、注入当前 `zhihu-auto-scroll.js`、通过自动化开关启动展开/滚动，并将 cookies 与同源 localStorage 转给 SingleFile CLI 的捕获页。
- 集成官方 `single-file-cli` 保存单文件 HTML 到 `archives/zhihu-question-<id>-<timestamp>.html`；`.auth/` 和 `archives/` 作为本地运行产物加入 `.gitignore`。
- SingleFile 不能直接读取 Playwright `storageState` 或抓取 Playwright 已滚动的同一 tab；当前采用 cookies/localStorage 转换加 SingleFile 捕获页内再次注入脚本并等待自动化完成的方案。
- 在 `TODO.md` 记录 Playwright 登录态与归档工作流的后续产品体验和技术可靠性优化项。
- 验证通过：`npm run check`、`npm test`、`npm run test:smoke`；真实知乎登录和保存需要人工登录，当前环境未执行完整线上归档。

# 1.4.0 - 2026-06-16

- 控制面板默认收起为一个小按钮，首次打开知乎页面时不遮挡正文。
- 面板增加“隐藏”按钮；展开/收起状态写入 localStorage，刷新后恢复上次状态；收起小按钮也支持拖动并保存位置。
- 存储逻辑统一为 localStorage，移除 `@grant none` 下用不到的 GM 存储兜底和旧分散 key 迁移。
- 增加知乎 `.Modal-content` 评论弹窗识别，并在关闭按钮位于弹窗内容外层时仍能自动关闭。
- 评论模式不再每轮全页扫描 `.ContentItem-actions`；改为发现回答时注册评论操作栏，并只处理视口附近的操作栏。
- 单轮展开处理中缓存按钮分类结果，避免同一候选元素重复读取文本、容器和布局信息。
- 面板模板、面板样式和点击分类逻辑拆出独立函数/对象，降低主创建流程和展开流程的阅读成本。

# 1.3.1 - 2026-06-16

- “已发现回答”在知乎批量加载回答时按 `+1` 连续更新，不再从 10 直接跳到 15。

# 1.3.0 - 2026-06-16

- 评论模式等待每段平滑滚动结束后再检查答案底部，避免 `16x / 200ms` 时滚动动画重叠并漏过评论入口。
- 点击评论入口或回复展开按钮后暂停向下滚动，等待评论 DOM 追加完成。
- 评论入口只有确认评论容器出现后才标记完成；临时无效果时停留原位并有限重试。

# 1.2.0 - 2026-06-16

- 增加持久化的“展开评论”开关，默认关闭。
- 开启后仅在答案底部点击评论入口，忽略答案阅读过程中的悬浮评论栏。
- 评论内出现“展开其他 N 条回复”时递归展开，直到没有更多回复按钮。
- 评论模式限制单次滚动距离，避免高倍速跳过答案底部评论入口。

# 1.1.0 - 2026-06-16

- 面板新增“已发现回答/总回答数”进度；优先按知乎回答 ID 去重，无法提取总数时显示未知。
- 后台标签页不再累计无进展轮次或误触发自动暂停，恢复可见后立即继续。
- 自动暂停提示改为明确的“已发现全部回答”或“连续多轮无新回答”。
- 普通滚动和底部回弹始终使用平滑动画；暂停后不再发起新滚动，已经启动的动画自然结束。

# 1.0.0 - 2026-06-16

- 将运行逻辑重构为可取消的一次性自调度循环；暂停和页面离开会清理调度、观察器和当前异步任务。
- 将回答展开改为回答区/列表区限定的增量处理，支持失败冷却重试并忽略面板、评论区和侧栏。
- 增加知乎 SPA 页面切换处理、版本化存储迁移、可靠进度信号和受限调试 API。
- 改进面板可访问性、Pointer Events 拖动、位置约束和缓存渲染。
- 移除合成 wheel 事件，增加纯逻辑、DOM 策略和 Playwright 渲染冒烟测试。
- 修正执行间隔语义：按相邻主轮次的起始时间计算，不再把固定滚动后等待时间叠加到用户设置上。
