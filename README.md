<div id="top"></div>

<p align="center">Help us grow and star us on Github! ⭐️</p>

<p align="center">

<a href="https://formbricks.com">

<img width="120" alt="Open Source Privacy First Experience Management Solution Qualtrics Alternative Logo" src="https://github.com/formbricks/formbricks/assets/72809645/0086704f-bee7-4d38-9cc8-fa42ee59e004">

</a>

<h3 align="center">Formbricks</h3>

<p align="center">
The Open Source Qualtrics Alternative
<br />
<a href="https://formbricks.com/">Website</a>
</p>
</p>

<p align="center">
<a href="https://github.com/formbricks/formbricks/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-AGPL-purple" alt="License"></a> <a href="https://github.com/formbricks/formbricks/stargazers"><img src="https://img.shields.io/github/stars/formbricks/formbricks?logo=github" alt="Github Stars"></a>
<a href="https://insights.linuxfoundation.org/project/formbricks"><img src="https://insights.linuxfoundation.org/api/badge/health-score?project=formbricks"></a>
<a href="https://news.ycombinator.com/item?id=32303886"><img src="https://img.shields.io/badge/Hacker%20News-122-%23FF6600" alt="Hacker News"></a>
<a href="[https://www.producthunt.com/products/formbricks](https://www.producthunt.com/posts/formbricks)"><img src="https://img.shields.io/badge/Product%20Hunt-455-orange?logo=producthunt&logoColor=%23fff" alt="Product Hunt"></a>
<a href="https://github.blog/2023-04-12-github-accelerator-our-first-cohort-and-whats-next/"><img src="https://img.shields.io/badge/2023-blue?logo=github&label=Github%20Accelerator" alt="Github Accelerator"></a>
<a href="https://github.com/formbricks/formbricks/issues?q=is:issue+is:open+label:%22%F0%9F%99%8B%F0%9F%8F%BB%E2%80%8D%E2%99%82%EF%B8%8Fhelp+wanted%22"><img src="https://img.shields.io/badge/Help%20Wanted-Contribute-blue"></a>
</p>

<br/>

<div style="background-color:#f8fafc; border-radius:5px;">
<p align="center">
<i>Trusted by</i><br/>
  <img width="867" alt="clients-hi-res" src="https://github.com/formbricks/formbricks/assets/72809645/924d3693-f66a-4063-bb31-6e5789a8175a">
</p>
<div>

<p align="center">
<a href="https://trendshift.io/repositories/2570" target="_blank"><img src="https://trendshift.io/api/badge/repositories/2570" alt="Trendshift Badge for formbricks/formbricks" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</p>

## ✨ 关于 Formbricks

<img width="1527" alt="formbricks-sneak" src="https://github-production-user-asset-6210df.s3.amazonaws.com/675065/249441967-ccb89ea3-82b4-4bf2-8d2c-528721ec313b.png">

Formbricks 是一个免费开源的问卷调查平台。通过精美的应用内、网站、链接和电子邮件调查，在用户旅程的每个环节收集反馈。基于 Formbricks 构建或利用预构建的数据分析功能。

**在云端试用：[formbricks.com](https://app.formbricks.com/auth/signup)**

## 💪 使命：赋能你的团队，打造无可抗拒的体验

Formbricks 是一个免费开源的问卷调查平台，也是一个隐私优先的体验管理平台。使用应用内、网站、链接和电子邮件调查来收集用户和客户洞察。利用 Formbricks Insight Platform 或构建你自己的平台。生命太短暂，不能浪费在平庸的 UX 上。

### 功能特性

- 📲 使用无代码编辑器创建**转化优化调查**，支持多种问题类型
- 📚 从多种最佳实践**模板**中选择
- 👩🏻 启动并**定向投放调查**到特定用户群，无需修改应用代码
- 🔗 创建可分享的**链接调查**
- 👨‍👩‍👦 邀请组织成员**协作**管理调查
- 🔌 集成 **Slack、Notion、Zapier、n8n** 等
- 🔒 完全**开源**，透明且可自托管

### 技术栈

- 💻 [TypeScript](https://www.typescriptlang.org/)
- 🚀 [Next.js](https://nextjs.org/)
- ⚛️ [React](https://reactjs.org/)
- 🎨 [TailwindCSS](https://tailwindcss.com/)
- 📚 [Prisma](https://prisma.io/)
- 🔒 [Better Auth](https://www.better-auth.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🐛 [Vitest](https://vitest.dev/)
- ☁️ [Cloudflare Workers](https://workers.cloudflare.com/)

## 🚀 一键部署到 Cloudflare Workers

### 前置条件

- [Cloudflare](https://dash.cloudflare.com/sign-up) 账号
- [Supabase](https://supabase.com/) 账号（提供 PostgreSQL 数据库）
- [GitHub](https://github.com/) 账号

### 部署步骤

#### 第一步：Fork 本仓库

点击本仓库右上角的 **Fork** 按钮，将仓库复制到你的 GitHub 账号下。

#### 第二步：在 Cloudflare 创建 API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **My Profile → API Tokens**
3. 点击 **Create Token**，选择 **Create Custom Token**
4. 添加以下权限：
   - `Account / Workers KV Storage / Edit`
   - `Account / Workers Scripts / Edit`
   - `Account / R2 Storage / Edit`
   - `Account / Cloudflare Queues / Edit`
5. 在 **Account Resources** 中选择你的账号
6. 复制生成的 Token

#### 第三步：在 Cloudflare 创建 Worker

1. 进入 **Workers & Pages**，点击 **Create application**
2. 选择 **Workers** 标签，点击 **Create Worker**
3. 命名为 `formbricks-worker`，点击 **Deploy**
4. 进入 Worker 的 **Settings → Integrations → Git**，点击 **Connect to Git**
5. 选择你 Fork 的 `formbricks-worker` 仓库
6. 配置构建设置：

| 设置项 | 值 |
|--------|-----|
| **Build command** | `pnpm install && pnpm build:cf` |
| **Build output directory** | `.open-next` |
| **Root directory** | `apps/web` |

7. 添加环境变量（见下方环境变量表）
8. 点击 **Save and Deploy**

#### 第四步：配置环境变量

在 Cloudflare Worker 的 **Settings → Variables** 中添加以下变量：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（第二步创建） | `xxxxxxxxxxxxxxxx` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（Dashboard 右侧栏可见） | `xxxxxxxxxxxxxxxx` |
| `DATABASE_URL` | PostgreSQL 连接字符串（Supabase 或 Neon） | 见下方说明 |
| `WEBAPP_URL` | 你的应用 URL | `https://your-app.workers.dev` |
| `BETTER_AUTH_URL` | 同 WEBAPP_URL | `https://your-app.workers.dev` |
| `BETTER_AUTH_SECRET` | 随机密钥（32位以上） | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 加密密钥（32位十六进制） | `openssl rand -hex 32` |
| `CRON_SECRET` | Cron 任务密钥 | `openssl rand -hex 32` |
| `LOG_LEVEL` | 日志级别 | `info` |

**数据库连接字符串格式**：

- **Supabase**：`postgresql://postgres:password@db.xxx.supabase.co:5432/postgres`
- **Neon**：`postgresql://user:password@ep-xxx.region.aws.neon.tech/dbname?sslmode=require`

> **全自动初始化**：构建过程中会自动完成以下操作，无需手动执行：
> - 数据库迁移（`prisma migrate deploy`）
> - KV 命名空间创建（如不存在）
> - R2 存储桶创建（如不存在）
> - Queue 创建（如不存在）
> - 资源绑定配置自动更新

#### 第五步：绑定域名（可选）

1. 进入 Worker 的 **Settings → Domains & Routes** 标签
2. 点击 **Add domain**
3. 输入你的域名，按提示配置 DNS 记录
4. 等待 DNS 生效，即可通过域名访问

### 部署完成

部署完成后，访问你的 Cloudflare Workers URL（如 `https://your-app.workers.dev`），即可开始使用 Formbricks。

**首次访问时**，系统会自动创建管理员账户，使用你设置的 `BETTER_AUTH_URL` 访问注册页面即可。

## 🐳 本地开发

### 前置要求

- [Node.js](https://nodejs.org/en) 20+
- [Pnpm](https://pnpm.io/)
- [Docker](https://www.docker.com/)

### 本地运行

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev

# 打开 http://localhost:3000
```

## 📖 文档

- [官方文档](https://formbricks.com/docs)
- [API 参考](https://formbricks.com/docs/api)
- [自托管指南](https://formbricks.com/docs/self-hosting/deployment)

## 🤝 贡献

我们欢迎各种形式的贡献：

- Star 本仓库
- 提交 Issue 反馈问题
- 为 Issue 投票（👍）帮助我们排优先级

## 📆 联系我们

<a href="https://cal.com/johannes/onboarding?utm_source=banner&utm_campaign=oss"><img alt="Book us with Cal.com" src="https://cal.com/book-with-cal-dark.svg" /></a>

## 🔒 安全

我们非常重视安全问题。如果发现安全漏洞，请发送邮件至 security@formbricks.com。

## 👩‍⚖️ 许可证

### AGPL Formbricks 核心

Formbricks 核心应用基于 [AGPLv3 开源许可证](https://github.com/formbricks/formbricks/blob/main/LICENSE)。核心应用完全免费，包含设计和管理链接调查、网站调查和应用内调查所需的一切功能。

### 企业版

除 AGPL 许可的 Formbricks 核心外，本仓库还包含基于企业版许可证的代码。企业版功能位于 `/apps/web/modules/ee` 文件夹中。

<div style="background-color:#f8fafc; border-radius:5px;">
<p align="center">
<i>Supported by</i><br/>
<a href="https://www.chromatic.com/"><img src="https://user-images.githubusercontent.com/321738/84662277-e3db4f80-af1b-11ee-88f5-91d67a5e59f6.png" width="153" height="30" alt="Chromatic" /></a>
&nbsp;&nbsp;&nbsp;&nbsp;
<a href="https://sentry.io/"><img src="https://github.com/user-attachments/assets/d743ffd4-b575-4802-a29a-10136be9227e" width="150" height="30" alt="Sentry" /></a>
</p>
</div>

<a href="https://github.com/formbricks/formbricks/graphs/contributors">
<img src="https://contrib.rocks/image?repo=formbricks/formbricks" />
</a>
