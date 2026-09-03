# 选课系统

一个轻量级的高校选课系统。管理员可配置课程和提前批次开放时间，学生到达开放时间后可抢课。基于 PostgreSQL 行锁 + BullMQ 队列防止超卖并支撑高并发。

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js + TypeScript（tsx 直接运行，免编译） |
| Web 框架 | Express.js 4 |
| ORM | Drizzle ORM |
| 数据库 | PostgreSQL |
| 缓存/队列/Session | Redis |
| 队列 | BullMQ |
| 模板引擎 | EJS |
| Session | express-session + connect-redis |
| 密码 | bcryptjs |
| 前端样式 | Tailwind CSS 3 |
| 前端交互 | HTMX 2.x（CDN） |

## 快速开始

需要本地运行 PostgreSQL 和 Redis：

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，设置 DATABASE_URL、REDIS_URL 和 SESSION_SECRET

# 3. 初始化数据库并写入种子数据
npm run db:init

# 4. 启动 Web 服务
npm run dev

# 5. 另开一个终端启动选课队列 Worker
npm run worker
```

打开 http://localhost:8080。

`db:init` 可重复执行：数据库已有用户时会保留现有数据，不会重新写入演示数据。

## 默认账号

| 角色 | 用户名 | 密码 |
|---|---|---|
| 管理员 | admin | 123 |
| 学生 | student | 123 |

## 目录结构

```
src/
├── index.ts                 # Web 进程入口
├── app.ts                   # Express 中间件配置与路由挂载
├── workers/
│   └── selection.ts         # BullMQ 选课队列 Worker
├── css/
│   └── input.css            # Tailwind CSS 源文件
├── db/
│   ├── index.ts             # PostgreSQL 连接池
│   ├── schema.ts            # Drizzle ORM 表结构定义
│   └── seed.ts              # 种子数据
├── lib/
│   ├── redis.ts             # Redis 连接
│   └── queue.ts             # BullMQ 选课队列
├── middleware/
│   └── auth.ts              # requireAuth / requireAdmin 鉴权中间件
├── routes/
│   ├── auth.ts              # 登录 / 退出
│   ├── pages.ts             # 页面路由（GET）
│   ├── profile.ts           # 学生资料查看与修改
│   ├── courses.ts           # 学生端：课程列表、抢课、退课
│   ├── selections.ts        # 学生端：我的选课
│   ├── admin-courses.ts     # 管理端：课程管理 + 全局配置
│   ├── admin-access.ts      # 管理端：提前批次管理
│   ├── admin-users.ts       # 管理端：用户管理
│   └── admin-class.ts       # 管理端：班级/选课名单管理
├── services/                # 账号、年级资格与选课规则
├── utils/
│   ├── parse-id.ts          # 路由 ID 参数安全解析
│   ├── phone.ts             # 手机号标准化与校验
│   └── time.ts              # 中国时间格式化工具
├── types/
│   └── express.d.ts         # Session 类型扩展
└── views/
    ├── layout.ejs           # 主布局（导航、toast）
    ├── login.ejs            # 登录页
    ├── profile.ejs          # 学生个人资料页
    ├── courses.ejs          # 课程列表页
    ├── _course-card.ejs     # 课程卡片组件
    ├── _course-select-pending.ejs  # 排队中卡片
    ├── selections.ejs       # 我的选课页
    ├── admin-courses.ejs    # 课程管理页
    ├── admin-access.ejs     # 提前批次管理页
    ├── admin-users.ejs      # 用户管理页
    ├── admin-class.ejs      # 班级管理页
    ├── _user-row.ejs        # 用户行组件
    └── _components/         # 通用 UI 组件
        ├── badge.ejs
        ├── button.ejs
        ├── card.ejs
        ├── empty-state.ejs
        ├── form-field.ejs
        └── toast.ejs
```

## 核心功能

### 学生端

- 查看课程列表（仅显示当前年级允许的课程）及管理员维护的课程说明，显示剩余名额和精确到秒的开放/截止倒计时
- 到达开放时间后点击抢课（HTMX 局部更新）。请求进入 BullMQ 队列异步处理，前端显示"排队中"并轮询结果
- 已选课程数达到最大报课数后，浏览器会禁用其余抢课按钮
- 查看已选课程，支持退课
- 首次登录缺少手机号时必须先补全资料；可修改手机号、班级、年级和密码

### 管理端

- 课程 CRUD + 重置名额
- 设置精确到秒的全局开始时间 `start_time` 和截止时间 `end_time`（均按中国时间保存和执行）
- 维护学生课程页顶部的课程说明 `course_instructions`
- 学生年级 `grade` 与课程允许年级 `allowed_grades`（四位年级标识）
- 管理提前批次（为指定学生对指定课程设置更早的开放时间）
- 用户管理（按用户名或昵称查询，维护密码、手机号、班级和年级）
- 班级管理（查看某门课已选学生、批量导入选课名单）
- 站点标题 `site_title` 和最大选课数 `max_selections` 配置

### 开放时间优先级

有效开放时间取 **全局开始时间** 与课程开放时间的较晚者：

1. 查询 `access` + `access_users` 是否有该学生的提前批次记录 → 有则使用最早的 `access.open_time`
2. 否则使用 `courses.open_time`（默认开放时间）
3. 再与全局 `start_time` 取较晚值；到达 `end_time` 后全部截止

时间一律按中国时区 `Asia/Shanghai` 计算，并以本地日历字符串存储和比较（`YYYY-MM-DDTHH:mm:ss`，不带 `Z` / UTC）。

### 年级限制

- 学生账号保存四位 `grade` 标识，界面统一显示为“2026级”样式
- 课程 `allowed_grades` 为逗号分隔的四位年级标识，如 `2024,2026`；留空表示不限
- 学生端列表、抢课接口和管理员分班接口只允许该生 `grade` 对应的课程
- 修改学生 `grade` 或收紧课程 `allowed_grades` 时，会自动移除不符合条件的已有选课并恢复对应名额

## 抢课并发策略

- 抢课请求先经过轻量校验；课程已满的直接返回，其余进入 BullMQ 队列
- Worker 使用 PostgreSQL `SELECT ... FOR UPDATE` 行锁扣减名额并插入选课记录
- 多个 Worker 进程可并行处理不同课程的选课；同一课程的选课请求在行锁上串行
- `selections` 表 `UNIQUE(user_id, course_id)` 防止重复选课
- 业务错误（已满、已选过、时间未到等）通过 `UnrecoverableError` 标记，BullMQ 不会重试

## 可用脚本

```bash
npm run dev              # 开发模式（CSS watch + tsx watch 热重载）
npm start                # 生产模式（先编译 CSS 再启动 Web）
npm run worker           # 启动选课队列 Worker
npm run build:css        # 编译 Tailwind CSS
npm run db:push          # 推送 Drizzle schema 到数据库
npm run db:seed          # 写入种子数据
npm run db:init          # db:push + db:seed
npm run typecheck        # TypeScript 类型检查
npm test                 # 运行测试（需要本地 PostgreSQL + Redis）
```

## 部署

### Docker Compose（推荐）

```bash
cp .env.example .env
# 编辑 .env，设置 SESSION_SECRET
docker compose up -d
```

Compose 会启动 `postgres`、`redis`、`app`（Web 服务）和 `worker`（选课队列 Worker）四个服务。Worker 可以水平扩展：

```bash
docker compose up -d --scale worker=4
```

### 手动部署

```bash
npm run db:init
NODE_ENV=production \
  DATABASE_URL=postgres://... \
  REDIS_URL=redis://... \
  SESSION_SECRET="请替换为足够长的随机值" \
  npm start
```

端口 8080，前面套 Nginx/Caddy 反代 + SSL。生产模式必须提供 `SESSION_SECRET`，且浏览器只会通过 HTTPS 发送 Session Cookie。
