/**
 * Worker Entry Point - 路由转发到 QuestDO
 *
 * 所有 API 请求（/api/*）都被转发到对应的 Quest Durable Object 实例。
 * 静态文件（index.html, admin.html）由 Workers Sites / Assets 自动提供。
 *
 * 路由设计：
 *   GET  /api/submit?id=G-001  ->  公共账本（脱敏）
 *   POST /api/submit?id=G-001  ->  抢单写入
 *   GET  /api/admin?id=G-001   ->  完整账本（需 ADMIN_SECRET）
 *   POST /api/admin?id=G-001   ->  状态修改（需 ADMIN_SECRET）
 */

import { QuestDO } from './quest-do';

// 导出 Durable Object 类，供 Cloudflare 运行时实例化
export { QuestDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 只处理 API 路由，静态文件由 Workers Sites / Assets 处理
    if (path.startsWith('/api/')) {
      return routeToDO(request, env);
    }

    // 其他所有请求（包括静态资源）由 assets 自动处理
    return env.ASSETS.fetch(request);
  }
};

/**
 * 将请求路由到对应的 QuestDO 实例
 */
async function routeToDO(request, env) {
  const url = new URL(request.url);
  const questId = url.searchParams.get('id') || 'G-001';

  // 1. 获取 DO Namespace（绑定名称为 QUEST_DO，在 wrangler.toml 中配置）
  const doNamespace = env.QUEST_DO;

  if (!doNamespace) {
    return new Response(
      JSON.stringify({
        error: 'Durable Object binding "QUEST_DO" 未配置，请检查 wrangler.toml'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' }
      }
    );
  }

  // 2. 通过 questId 生成稳定的 DO ID（同一任务始终路由到同一实例）
  const doId = doNamespace.idFromName(questId);

  // 3. 获取 DO 实例 stub（代理对象，所有调用都会发送到 DO 所在的数据中心）
  const doStub = doNamespace.get(doId);

  // 4. 转发原始请求到 DO
  // DO 内部保证串行处理，彻底消除竞态条件
  return doStub.fetch(request);
}
