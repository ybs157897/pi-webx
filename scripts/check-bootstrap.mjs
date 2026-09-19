/**
 * SSR 验收脚本的引导模块：让真实 React 组件能在 Node 里直接跑起来。
 *
 * 两件事：
 * 1. `import 'tsx'` —— 注册 TS/TSX 的加载支持。
 * 2. `module.registerHooks({...})` —— 在 tsx **之前**拦下 `.css` 导入并给一个模块。
 *
 * 顺序很关键：`--import a --import b` 的链式加载器是 tsx 先跑，它会对 `.css` 直接抛
 * `ERR_UNKNOWN_FILE_EXTENSION`，轮不到后面的 `load` 钩子；而 `registerHooks` 注册的钩子
 * 排在任何 `module.register` 加载器之前，所以这里是唯一能把样式请求短路掉的位置。
 * （`resolve` 里也要给出 `format: 'module'`，否则格式探测阶段就会失败。）
 *
 * CSS 模块给的是**回显键名的 Proxy**，不是空对象：断言里要能看见
 * `css.scrollBody` 挂在哪个元素上，空对象只会让每个类名都变成 `undefined`。
 *
 * 用法：`node --import ./scripts/check-bootstrap.mjs scripts/check-xxx.ts`
 */
import { registerHooks } from 'node:module';
import 'tsx';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes('.css')) return { ...resolved, format: 'module' };
    return resolved;
  },
  load(url, context, nextLoad) {
    if (url.includes('.css')) {
      return {
        format: 'module',
        source: 'export default new Proxy({}, { get: (_target, key) => String(key) });',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
