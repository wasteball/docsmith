/* 把图表引擎装成 window.mermaid，供 workspace.js 调用。
   没有完整版 mermaid 时由我们自己的引擎接管；有的话不覆盖。 */
import { install } from '../../diagrams/index.js';
install(window);
