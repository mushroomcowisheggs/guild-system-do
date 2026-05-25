/**
 * QuestDO - Durable Object for Quest State Management
 *
 * 单线程串行执行，消除 Read-Modify-Write 竞态条件。
 * 所有对同一任务的请求都会被路由到同一个 DO 实例，
 * DO 内部保证一次只处理一个请求，因此 hunters 数组的读写是原子性的。
 */

const MAX_SLOTS = 50;
const STORAGE_KEY = 'hunters';

export class QuestDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // 内存缓存：在 DO 生命周期内缓存状态，减少 storage 读取
    this.hunters = null;
    // 初始化标志：确保 BlockConcurrencyWhile 只执行一次
    this.initialized = false;
  }

  /**
   * Durable Object 的入口方法
   * 所有请求（HTTP/WebSocket）都通过这里进入
   */
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 使用 BlockConcurrencyWhile 确保初始化逻辑串行执行
    // 这保证了 DO 启动时的 hunters 加载是线程安全的
    if (!this.initialized) {
      await this.state.blockConcurrencyWhile(async () => {
        if (!this.initialized) {
          this.hunters = await this.state.storage.get(STORAGE_KEY) || [];
          this.initialized = true;
        }
      });
    }

    // CORS 响应头
    const corsHeaders = this.buildCorsHeaders(request);

    try {
      // 路由分发
      if (path === '/api/submit' && request.method === 'GET') {
        return this.handleGetPublicLedger(corsHeaders);
      }

      if (path === '/api/submit' && request.method === 'POST') {
        return this.handleSubmit(request, corsHeaders);
      }

      if (path === '/api/admin' && request.method === 'GET') {
        return this.handleGetFullLedger(request, corsHeaders);
      }

      if (path === '/api/admin' && request.method === 'POST') {
        return this.handleUpdateStatus(request, corsHeaders);
      }

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      return new Response('Not Found', { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(
        JSON.stringify({ error: '崩溃: ' + err.message }),
        { status: 500, headers: corsHeaders }
      );
    }
  }

  // ==========================================
  // GET /api/submit - 公共账本（脱敏）
  // ==========================================
  async handleGetPublicLedger(corsHeaders) {
    const publicHunters = this.hunters.map(h => ({
      name: h.name,
      timestamp: h.timestamp,
      status: h.status || 'PENDING'
    }));

    return new Response(
      JSON.stringify({ hunters: publicHunters }),
      { headers: corsHeaders }
    );
  }

  // ==========================================
  // POST /api/submit - 抢单写入
  // ==========================================
  async handleSubmit(request, corsHeaders) {
    const formData = await request.formData();
    const questId = formData.get('quest_id');
    const name = formData.get('hunter_name');
    const email = formData.get('hunter_email');

    // 1. 参数校验
    if (!questId || !name || !email) {
      return new Response('错误：参数不完整。', { status: 400, headers: corsHeaders });
    }

    const trimmedName = name.toString().trim();
    const trimmedEmail = email.toString().trim();

    if (!trimmedName || !trimmedEmail) {
      return new Response('错误：参数不能为空。', { status: 400, headers: corsHeaders });
    }

    // 2. 超卖检查
    // 在 DO 的串行执行模型下，this.hunters.length 的读取是准确的
    // 不会因为并发导致 "同时读到 49" 的问题
    if (this.hunters.length >= MAX_SLOTS) {
      return new Response('名额已满', { status: 403, headers: corsHeaders });
    }

    // 3. 邮箱防女巫检查
    const isEmailExists = this.hunters.some(h => h.email === trimmedEmail);
    if (isEmailExists) {
      return new Response('该邮箱已经接取过此任务', { status: 403, headers: corsHeaders });
    }

    // 4. 用户名唯一性检查
    const isNameExists = this.hunters.some(h => h.name === trimmedName);
    if (isNameExists) {
      return new Response('该代号已被占用', { status: 403, headers: corsHeaders });
    }

    // 5. 数据组装
    const newHunter = {
      name: trimmedName.substring(0, 15), // 防恶意超长文本
      email: trimmedEmail,
      timestamp: new Date().toISOString(),
      status: 'PENDING'
    };

    // 6. 内存更新 + 持久化（原子操作）
    // 由于 DO 串行执行，以下操作是原子的，不会出现并发覆盖
    // 校验通过后，构造新数组（不直接修改 this.hunters）
    const newHunters = [...this.hunters, newHunter];

    // 先持久化（原子写入）
    await this.state.storage.put(STORAGE_KEY, newHunters);

    // 持久化成功，再替换内存
    this.hunters = newHunters;

    return new Response('OK', { status: 200, headers: corsHeaders });
  }

  // ==========================================
  // GET /api/admin - 完整账本（需授权）
  // ==========================================
  async handleGetFullLedger(request, corsHeaders) {
    // 1. 权限校验
    const authResult = this.checkAuth(request);
    if (authResult !== true) {
      return authResult;
    }

    // 2. 返回完整数据（包含邮箱等敏感信息）
    return new Response(
      JSON.stringify({ hunters: this.hunters }),
      { headers: corsHeaders }
    );
  }

  // ==========================================
  // POST /api/admin - 状态更新（需授权）
  // ==========================================
  async handleUpdateStatus(request, corsHeaders) {
    // 1. 权限校验
    const authResult = this.checkAuth(request);
    if (authResult !== true) {
      return authResult;
    }

    // 2. 解析请求体
    const body = await request.json();
    const targetEmail = body.email;
    const newStatus = body.status;

    if (!targetEmail || !newStatus) {
      return new Response(
        JSON.stringify({ error: '参数不完整' }),
        { status: 400, headers: corsHeaders }
      );
    }

    // 3. 查找并更新
    let updated = false;
    // 基于当前内存生成新数组
    const newHunters = this.hunters.map(h => {
      if (h.email === targetEmail) {
        updated = true;
        return { ...h, status: newStatus };
      }
      return h;
    });

    if (!updated) {
      return new Response(
        JSON.stringify({ error: '未找到对应的猎人邮箱' }),
        { status: 404, headers: corsHeaders }
      );
    }

    // 4. 内存更新 + 持久化
    // 先持久化
    await this.state.storage.put(STORAGE_KEY, newHunters);

    // 再更新内存
    this.hunters = newHunters;

    return new Response(
      JSON.stringify({ success: true }),
      { headers: corsHeaders }
    );
  }

  // ==========================================
  // 辅助方法
  // ==========================================

  /**
   * 校验管理员密钥
   */
  checkAuth(request) {
    const secretKey = this.env.ADMIN_SECRET;
    const providedKey = request.headers.get('Authorization');

    // 环境变量未配置检查
    if (typeof secretKey === 'undefined' || secretKey === '') {
      const corsHeaders = this.buildCorsHeaders(request);
      return new Response(
        JSON.stringify({
          error: '云端未检测到 ADMIN_SECRET 环境变量配置，请去 Cloudflare 后台设置'
        }),
        { status: 500, headers: corsHeaders }
      );
    }

    // 密钥匹配检查
    if (providedKey !== secretKey) {
      const corsHeaders = this.buildCorsHeaders(request);
      return new Response(
        JSON.stringify({ error: 'Access Denied: 密钥不匹配或越权访问' }),
        { status: 403, headers: corsHeaders }
      );
    }

    return true;
  }

  /**
   * 构建 CORS 响应头
   */
  buildCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '*';
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json;charset=UTF-8'
    };
  }
}
