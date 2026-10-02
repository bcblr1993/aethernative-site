import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // push-service 使用 node:test，由它自己的 npm test 运行
  test: { exclude: [...configDefaults.exclude, 'push-service/**'] },
});
