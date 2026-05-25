# 慈善家工会悬赏板 (Durable Objects 版本)

## Bug 修复说明

### 原始 Bug
**位置**: `submit.js` 的 `onRequestPost` 函数 (Read-Modify-Write 模式)

**问题描述**:
原始架构使用 Cloudflare KV 存储，流程为：
1. 读取当前账本 `state = await KV.get(key)`
2. 检查 `state.hunters.length >= 50`
3. 推送新数据 `state.hunters.push(newHunter)`
4. 覆写 `await KV.put(key, JSON.stringify(state))`

**竞态条件**: 当第50人和第51人在同一毫秒完成10秒弹窗并提交时：
- 两人同时读取到 `hunters.length = 49`
- 两人都通过上限校验
- 后者的 `put` 覆盖前者的数据
- **结果**: 超卖（51人）或数据丢失

### 修复方案: Cloudflare Durable Objects

**原理**: Durable Object 为每个任务实例提供**强一致性**的单线程执行模型。所有请求通过 HTTP 被同一个 DO 实例串行处理。

**实现**:
- 创建 `QuestDO` 类，内部维护 `this.hunters` 状态
- `applyAddHunter()` 方法中完成读取→校验→写入的全部操作
- DO 运行时保证同一实例**一次只处理一个请求**
- 状态持久化使用 `this.state.storage.put()`

**关键代码** (`src/quest-do.js`):
```javascript
// DO 内部，这段代码是串行执行的——永远不会出现并发覆盖
if (this.hunters.length >= MAX_SLOTS) {
    return new Response('名额已满', { status: 403 });
}
// ... 校验、内存操作、持久化 ...
```

**优点**:
- 彻底消除竞态条件，无需分布式锁
- 逻辑清晰，仍在 Cloudflare 生态内
- 支持 `blockConcurrencyWhile` 进行原子性初始化

## 项目结构

```
guild-system-do/
├── backend/
│   ├── index.js          # Worker 入口：API 路由转发到 DO
│   └── quest-do.js       # QuestDO Durable Object 类
├── frontend/
│   ├── protected
│   └── public
│         ├── index.html        # 前端抢单页面
│         └── admin.html        # 管理后台
├── wrangler.toml               # Cloudflare 配置（含 DO 绑定）
├── package.json                # 依赖项
└── README.md
```

## 部署步骤

1. 安装依赖:
   ```bash
   npm install
   ```

2. 登录 Cloudflare:
   ```bash
   npx wrangler login
   ```

3. 设置管理员密钥（生产环境必须）:
   ```bash
   npx wrangler secret put ADMIN_SECRET
   # 输入你的密钥
   ```

4. 首次部署（含 DO 迁移）:
   ```bash
   npx wrangler deploy
   ```

5. 访问 `https://your-worker.your-subdomain.workers.dev/` 即可使用

注意：管理员前端默认地址应类似 https://charity-guild-system.你的子域.workers.dev
## 环境变量

| 变量名 | 说明 | 设置方式 |
|--------|------|----------|
| `ADMIN_SECRET` | 管理后台访问密钥 | `wrangler secret put ADMIN_SECRET` |

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/submit?id=G-001` | 获取公共账本（脱敏） |
| POST | `/api/submit?id=G-001` | 抢单提交 |
| GET | `/api/admin?id=G-001` | 获取完整账本（需密钥） |
| POST | `/api/admin?id=G-001` | 修改状态（需密钥） |

## 特别说明：关于去中心化

### 现有透明性措施
- **公共账本 API**（`GET /api/submit`）：返回所有猎人的代号、接单时间、状态（PENDING/SETTLED/REJECTED），不返回邮箱。任何人都可以查询，实时看到当前名额占用情况。
- **代码开源**：代码公开，用户可以审查业务逻辑（名额限制、唯一性校验等）。

### 透明性缺陷
| 问题 | 说明 |
|------|------|
| **数据存储不公开** | 底层 KV/DO 存储完全由 Cloudflare 托管，外部无法获取原始数据库文件或哈希校验和。用户只能信任 API 返回的数据未被篡改。 |
| **无操作审计日志** | 管理员通过 `POST /api/admin` 修改状态时，DO 仅更新 hunters 数组，**不记录谁、何时、从什么状态改成什么状态**。管理员恶意将“已核销”改回“待结算”或直接删除记录无法追溯。 |
| **单方控制修改权** | 拥有 `ADMIN_SECRET` 的人可以任意修改任何记录，无需其他见证。没有多签或共识机制。 |
| **无数据完整性证明** | 没有类似 Merkle Tree 或哈希链的机制让用户可以验证自己看到的账本与全球最新版本一致，且未被回滚。 |

**结论**：这是一个**中心化信任模型**——用户必须相信 Cloudflare 不出问题，且管理员密钥持有者诚实。不完全满足去中心化公开透明要求。未来需要引入更多措施。

### 待实现功能
| 功能 | Durable Objects 版 |
|------|--------------------|
| **防刷（速率限制）** | 在 DO 内部维护 `this.rateMap`，使用 `storage.get`/`put` 持久化（避免内存重启丢失） |
| **多签核销** | 在 `handleUpdateStatus` 中验证多个签名头 `X-Signature-1`、`X-Signature-2` |
| **审计日志** | 新增 `this.auditLog` 数组，每次状态变更 `push` 并 `storage.put`；提供 `/api/audit` 接口只读返回 |
| **Merkle 树公开验证** | 每次 `fetch` 时动态计算根哈希，并返回响应头 `X-Merkle-Root`；客户端可校验 |
| **定期对外哈希** | 使用 `cron trigger`（Workers Cron）每小时调用自己内部接口，将根哈希发往 Twitter/Webhook |
