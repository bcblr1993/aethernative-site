// Pages Functions 的运行时绑定。密钥线上在 Cloudflare Pages 后台配置，本地写在 .dev.vars。
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  /** 推送服务调用 /api/admin/push-* 的令牌（至少 32 字符），与服务器 push-service/.env 中的值相同 */
  PUSH_SERVICE_TOKEN?: string;
  /** 用 Apple 登录（iPhone App）：Team ID、Sign in with Apple 私钥（.p8 内容）及其 Key ID */
  APPLE_TEAM_ID?: string;
  APPLE_SIWA_KEY_ID?: string;
  APPLE_SIWA_KEY?: string;
  /** 加密保存 Apple refresh token 的 AES-256 密钥：openssl rand -base64 32 */
  APPLE_TOKEN_KEY?: string;
  /** 默认 com.aethernative.app */
  APPLE_BUNDLE_ID?: string;
}
