/** 统一使用软件的 repo 配置；拒绝账号首页、子页面和外站地址。 */
export function githubLinks(repo: string | undefined) {
  if (!repo) return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(repo);
  if (!match || ['.', '..'].includes(match[2])) return null;
  const url = `https://github.com/${match[1]}/${match[2].replace(/\.git$/, '')}`;
  return { repo: url, issues: `${url}/issues` };
}
