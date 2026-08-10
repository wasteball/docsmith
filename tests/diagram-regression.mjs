import assert from 'node:assert/strict';

import { cleanLabel, seriesClass } from '../src/diagrams/base.js';
import { parse as parseFlow } from '../src/diagrams/flowchart.js';
import {
  detect, registerRenderer, renderDiagram, supported,
} from '../src/diagrams/index.js';

const suppliedFlowchart = `flowchart TD
    A(["美信群消息到达"]):::entry
    A --> B{"is_skill_only_group(group_id)?"}:::decision
    B -->|"命中白名单"| C["handle_skill_only_group<br/>query / group_id / user_id"]:::skill
    B -->|"未命中"| D(["原有 LangGraph 流程"]):::legacy
    C --> E["_load_skill_history<br/>读 graph checkpointer 多轮历史"]:::proc
    E --> F["_call_skill_or_fallback<br/>execute_configured_skill(mip_code=user_id)"]:::proc
    F --> G["POST /skills/&#123;id&#125;/execute<br/>token + mipCode + history"]:::api
    G --> H{"Skill 执行结果"}:::decision
    H -->|命中| I["清洗答案 + 持久化 completed=True"]:::proc
    H -->|未命中| J["持久化 completed=True, answers=&#91;&#93;"]:::proc
    H -->|异常| K["持久化 completed=False + 兜底文案"]:::proc
    I --> L["_format_skill_reply<br/>&#123;query&#125; + 空行 + &#123;answer&#125;"]:::proc
    J --> L
    K --> L
    L --> M(["发送群回复"]):::result
    C -.->|"Skill 未启用或 checkpointer 未配置, 返回 None"| D

    classDef entry fill:#2563eb,color:#fff,stroke:#1d4ed8,stroke-width:2px
    classDef skill fill:#7c3aed,color:#fff,stroke:#6d28d9
    classDef legacy fill:#6b7280,color:#fff,stroke:#4b5563
    classDef proc fill:#059669,color:#fff,stroke:#047857
    classDef api fill:#db2777,color:#fff,stroke:#be185d
    classDef decision fill:#f59e0b,color:#1f2937,stroke:#d97706
    classDef result fill:#10b981,color:#fff,stroke:#059669`;

const graph = parseFlow(suppliedFlowchart, 'flow');
assert.equal(graph.nodes.size, 13);
assert.deepEqual(
  Object.fromEntries(['A', 'B', 'C', 'D', 'G', 'L', 'M'].map((id) => [id, graph.nodes.get(id).label])),
  {
    A: '美信群消息到达',
    B: 'is_skill_only_group(group_id)?',
    C: 'handle_skill_only_group\nquery / group_id / user_id',
    D: '原有 LangGraph 流程',
    G: 'POST /skills/{id}/execute\ntoken + mipCode + history',
    L: '_format_skill_reply\n{query} + 空行 + {answer}',
    M: '发送群回复',
  },
);
assert.equal(graph.nodes.get('A').shape, 'round');
assert.equal(graph.nodes.get('B').shape, 'diamond');
assert.equal(graph.nodes.get('M').shape, 'round');
assert.deepEqual(graph.classes.get('A'), ['entry']);
assert.deepEqual(graph.classes.get('C'), ['skill']);
assert.deepEqual(graph.styles.get('A'), {
  fill: '#2563eb', color: '#fff', stroke: '#1d4ed8', 'stroke-width': '2px',
});
assert.deepEqual(graph.styles.get('C'), { fill: '#7c3aed', color: '#fff', stroke: '#6d28d9' });
assert.equal(cleanLabel('&amp;#123; &#123; &#x5b;'), '&#123; { [');
assert.equal(seriesClass(8), 'dg-s7');

const svg = await renderDiagram(suppliedFlowchart);
assert.match(svg, /viewBox="0 0 \d+ \d+"/);
assert.match(svg, />美信群消息到达<\/text>/);
assert.match(svg, />is_skill_only_group\(group_id\)\?<\/text>/);
assert.match(svg, /dg-user-entry/);
assert.match(svg, /style="fill:#2563eb;stroke:#1d4ed8;stroke-width:2px"/);
assert.match(svg, /style="fill:#fff"/);
assert.match(svg, />POST \/skills\/\{id\}\/execute<\/text>/);
assert.doesNotMatch(svg, />A<\/text>/);

assert.equal(detect('\n%% comment\n flowchart LR\n A --> B')?.id, 'flowchart');
const classStatement = parseFlow(`flowchart LR
  A[甲] --> B[乙]
  classDef important fill:#112233,color:#fff
  class A,B important
  style B stroke:#abcdef`, 'flow');
assert.deepEqual(classStatement.classes.get('A'), ['important']);
assert.deepEqual(classStatement.styles.get('A'), { fill: '#112233', color: '#fff' });
assert.deepEqual(classStatement.styles.get('B'), {
  fill: '#112233', color: '#fff', stroke: '#abcdef',
});
assert.deepEqual(supported().map(({ id }) => id), [
  'flowchart', 'state', 'sequence', 'gantt', 'mindmap', 'quadrant', 'pie',
]);

const unregister = registerRenderer({
  id: 'test-chart',
  name: '测试图',
  match: /^testChart\b/i,
  normalize: (source) => source.trim().toUpperCase(),
  render: (source) => `<svg data-source="${source}"></svg>`,
});
assert.equal(detect('testChart hello')?.id, 'test-chart');
assert.equal(await renderDiagram('  testChart hello  '), '<svg data-source="TESTCHART HELLO"></svg>');
unregister();
assert.equal(detect('testChart hello'), null);

console.log('diagram regression: ok');
