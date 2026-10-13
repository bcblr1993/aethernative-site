import { describe, expect, it } from 'vitest';
import { githubLinks } from './github';

describe('GitHub 仓库映射', () => {
  it('保留软件对应的真实仓库名，并生成 Issues 地址', () => {
    expect(githubLinks('https://github.com/bcblr1993/ApexTerm')).toEqual({ repo: 'https://github.com/bcblr1993/ApexTerm', issues: 'https://github.com/bcblr1993/ApexTerm/issues' });
    expect(githubLinks('https://github.com/chenpingan529/NearGuard/')).toEqual({ repo: 'https://github.com/chenpingan529/NearGuard', issues: 'https://github.com/chenpingan529/NearGuard/issues' });
  });
  it('拒绝外站、用户主页和非仓库根路径', () => {
    for (const url of [undefined, 'https://github.com/user', 'https://evil.test/user/repo', 'javascript:alert(1)', 'https://github.com/u/r/issues', 'https://github.com/u/..']) expect(githubLinks(url)).toBeNull();
  });
});
