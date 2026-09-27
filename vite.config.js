import { defineConfig } from 'vite';

// base: './' 让构建产物用相对路径引用资源，
// 这样无论部署在 GitHub Pages 根路径还是 用户名.github.io/仓库名/ 子路径都能正常加载
export default defineConfig({
  base: './',
});