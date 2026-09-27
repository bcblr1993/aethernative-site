// Pages Functions 的运行时绑定。密钥线上在 Cloudflare Pages 后台配置，本地写在 .dev.vars。
export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}
