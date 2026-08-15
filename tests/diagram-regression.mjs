import assert from 'node:assert/strict';

import { cleanLabel, seriesClass } from '../src/diagrams/base.js';
import { parse as parseFlow } from '../src/diagrams/flowchart.js';
import { parseSequence, layoutSequence } from '../src/diagrams/extras.js';
import { sequenceLongMessagesWithNotes, flowchartSixSiblingSubgraphs,
  mermaidCaseExpectations } from './fixtures/mermaid-cases.mjs';
import {
  detect, registerRenderer, renderDiagram, renderFencedDiagram,
  supported, supportsFence, UnsupportedDiagram,
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

const sequenceModel = parseSequence(sequenceLongMessagesWithNotes);
assert.equal(sequenceModel.actors.length, mermaidCaseExpectations.sequence.actors);
assert.equal(sequenceModel.events.filter((event) => event.type === 'message').length, mermaidCaseExpectations.sequence.messages);
assert.equal(sequenceModel.events.filter((event) => event.type === 'note').length, mermaidCaseExpectations.sequence.notes);
const sequenceLayout = layoutSequence(sequenceModel);
assert.ok(sequenceLayout.width > 508, `长消息时序图应按内容扩展画布：${sequenceLayout.width}`);
assert.ok(sequenceLayout.events.some((event) => event.type === 'message' && event.lines.length > 1));
const sequenceSvg = await renderDiagram(sequenceLongMessagesWithNotes);
assert.match(sequenceSvg, /class="dg-note"/);
assert.match(sequenceSvg, /品牌名念错/);
assert.match(sequenceSvg, /data|viewBox="0 0 \d+ \d+"/);

const suppliedArchitecture = parseFlow(flowchartSixSiblingSubgraphs, 'flow');
assert.equal(suppliedArchitecture.groups.length, mermaidCaseExpectations.flowchart.groups);
assert.equal(suppliedArchitecture.nodes.size, mermaidCaseExpectations.flowchart.nodes);
const architectureSvg = await renderDiagram(flowchartSixSiblingSubgraphs);
assert.match(architectureSvg, /data-flow-view="overview"/);
assert.match(architectureSvg, /data-bundle-count="8"/);
assert.match(architectureSvg, /data-cross-group-edge-count="16"/);
const groupBoxes = [...architectureSvg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)" rx="14" class="dg-group/g)]
  .map((match) => match.slice(1, 5).map(Number));
const boxOverlap = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && ax + aw > bx
  && ay < by + bh && ay + ah > by;
assert.equal(groupBoxes.length, mermaidCaseExpectations.flowchart.groups);
assert.equal(groupBoxes.some((box, i) => groupBoxes.slice(i + 1).some((other) => boxOverlap(box, other))), false);
const architectureViewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(architectureSvg)?.slice(1).map(Number);
assert.ok(architectureViewBox && architectureViewBox[0] > architectureViewBox[1],
  `大型分层架构应横向展开：${architectureViewBox}`);
const architecturePaths = [...architectureSvg.matchAll(/<path d="([^"]+)" class="dg-edge(?:\s|\")/g)].map((match) => match[1]);
assert.equal(architecturePaths.length, 8, '概览只保留 8 条组内短关系');
assert.equal(architecturePaths.some((pathData) => /\bC/.test(pathData)), false,
  '复合分组图的边必须由正交通道路由，不能回退成自由贝塞尔线');
assert.equal((architectureSvg.match(/class="dg-bundle(?:\s|\")/g) || []).length, 8,
  '16 条跨组明细边必须聚合成 8 条关系束');
assert.equal((architectureSvg.match(/class="dg-bundle-hit"/g) || []).length, 8);
assert.equal((architectureSvg.match(/class="dg-bundle-label/g) || []).length, 8);
const bundleMembers = [...architectureSvg.matchAll(/data-bundle-members="([^"]+)"/g)]
  .filter((match, index, all) => all.findIndex((item) => item[1] === match[1]) === index)
  .flatMap((match) => match[1].split(','));
assert.equal(bundleMembers.length, 16);
assert.equal(new Set(bundleMembers).size, 16, '每条跨组原始边必须恰好归属一个关系束');
assert.match(architectureSvg, />4 项<\/text>/);
assert.match(architectureSvg, />回传 · 1 项<\/text>/);
assert.equal((architectureSvg.match(/data-node-id=/g) || []).length, 24);
const detailArchitectureSvg = await renderDiagram(flowchartSixSiblingSubgraphs, { view: 'detail' });
assert.match(detailArchitectureSvg, /data-flow-view="detail"/);
assert.equal((detailArchitectureSvg.match(/<path d="[^"]+" class="dg-edge(?:\s|\")/g) || []).length, 24);
const routingMetrics = Object.fromEntries([...detailArchitectureSvg.matchAll(/data-routing-([^=]+)="([^"]+)/g)]
  .map((match) => [match[1], Number(match[2])]));
assert.ok(routingMetrics.crossings <= 16, `明细图交叉数不得回归：${routingMetrics.crossings}`);
assert.equal(routingMetrics.overlaps, 0, `明细图不得出现重叠通道：${routingMetrics.overlaps}`);

const userFlowWithLabels = `flowchart LR
  H2["<b>H2 质量</b><br/>方案敢不敢用"] -->|"不成立则<br/>全盘归零"| H1["<b>H1 效率</b><br/>快不快"]
  H1 -->|"不成立则<br/>无商业价值"| H3["<b>H3 门槛</b><br/>谁能用"]
  H2 -.->|"先验证"| V["<b>验证顺序<br/>H2 → H1 → H3</b>"]`;
const userStateWithLoops = `stateDiagram-v2
  [*] --> 项目初始化
  项目初始化 --> 数据清洗 : 自动推进<br/>项目创建成功且与会话绑定
  数据清洗 --> 现状分析 : <b>确认推进</b><br/>清洗达标 + 用户确认
  现状分析 --> 选址建模 : <b>确认推进</b><br/>诊断完成 + 用户确认
  选址建模 --> 方案确认 : 自动推进<br/>求解成功
  方案确认 --> 报告生成 : <b>确认推进</b><br/>用户选定方案
  报告生成 --> [*] : <b>确认推进</b><br/>用户确认报告
  数据清洗 --> 数据清洗 : 阻断项未修复<br/>停留并定位到具体问题
  选址建模 --> 选址建模 : 无可行解<br/>回参数确认并给建议
  选址建模 --> 选址建模 : 参数变更<br/>生成新运行记录
  报告生成 --> 报告生成 : 生成失败<br/>保留旧版本并说明`;
const userParallelSubgraphs = `flowchart LR
  subgraph SEQ["契约未定义 → 串行"]
    A1["选址开发"] --> A2["选址完成"] --> A3["报告开发"]
  end
  subgraph PAR["契约冻结 → 并行"]
    B0["<b>定义契约</b>"] --> B1["选址开发"]
    B0 --> B2["报告开发<br/>（用契约造 mock 数据）"]
    B1 --> B3["联调"]
    B2 --> B3
  end`;
const userSubgraphEndpoints = `flowchart TB
  subgraph EXT["对外：商业交付场景"]
    E1["<b>用户</b>：方案组 / 售前专家"]
    E2["<b>痛点</b>：客户需求排队，接不下来"]
    E3["<b>价值</b>：承接量突破人力上限 → <b>收入</b>"]
    E4["<b>质量要求</b>：极高<br/>方案直接发客户，错了丢单"]
  end
  subgraph INT["对内：自主决策场景"]
    I1["<b>用户</b>：分公司仓网规划岗"]
    I2["<b>痛点</b>：能力在总部，需求上交排队"]
    I3["<b>价值</b>：自主完成标准场景 → <b>决策速度</b>"]
    I4["<b>质量要求</b>：中<br/>内部决策，可迭代修正"]
  end
  EXT -.->|"优先级 P0<br/>直接创收"| P["产品设计<br/>取舍依据"]
  INT -.->|"优先级 P1<br/>能力复用"| P`;
const stateGraph = parseFlow(userStateWithLoops, 'state');
assert.equal(stateGraph.edges.filter((edge) => edge.from === edge.to).length, 4);
const parallelGraph = parseFlow(userParallelSubgraphs, 'flow');
assert.equal(parallelGraph.groups.length, 2);
assert.deepEqual(parallelGraph.groups.map((group) => group.title), ['契约未定义 → 串行', '契约冻结 → 并行']);
const endpointGraph = parseFlow(userSubgraphEndpoints, 'flow');
assert.deepEqual(endpointGraph.edges.map(({ from, to }) => ({ from, to })), [
  { from: 'EXT', to: 'P' }, { from: 'INT', to: 'P' },
]);

const labelledFlowSvg = await renderDiagram(userFlowWithLabels);
const labelledFlowWidth = Number(/viewBox="0 0 ([\d.]+)/.exec(labelledFlowSvg)?.[1]);
assert.ok(labelledFlowWidth < 640, `边标签不应把简单流程图撑宽：${labelledFlowWidth}`);
const nodeBoxes = [...labelledFlowSvg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)" rx="[^\"]+" class="dg-shape/g)]
  .map((match) => match.slice(1, 5).map(Number));
const chipBoxes = [...labelledFlowSvg.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)" rx="5" class="dg-chip-bg/g)]
  .map((match) => match.slice(1, 5).map(Number));
const overlaps = ([ax, ay, aw, ah], [bx, by, bw, bh]) => ax < bx + bw && ax + aw > bx
  && ay < by + bh && ay + ah > by;
assert.equal(chipBoxes.length, 3);
assert.equal(chipBoxes.some((chipBox) => nodeBoxes.some((nodeBox) => overlaps(chipBox, nodeBox))), false);
assert.ok(chipBoxes.every(([x]) => x > 140), '边标签应位于节点之间，而不是被推到图左侧');

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
  'flowchart', 'state', 'sequence', 'gantt', 'mindmap', 'quadrant', 'pie', 'infographic',
]);
assert.equal(supportsFence('MERMAID'), true);
assert.equal(supportsFence(' infographic '), true);
assert.equal(supportsFence('javascript'), false);
assert.equal(detect('infographic list-row-horizontal-icon-arrow')?.id, 'infographic');
assert.deepEqual(supported().find(({ id }) => id === 'infographic')?.fences, ['infographic']);
assert.throws(
  () => renderFencedDiagram('mermaid', 'infographic list-row-horizontal-icon-arrow'),
  (error) => error instanceof UnsupportedDiagram && error.unsupportedKind === 'mermaid',
);
assert.throws(
  () => renderFencedDiagram('infographic', 'flowchart LR\n A --> B'),
  (error) => error instanceof UnsupportedDiagram && error.unsupportedKind === 'infographic',
);

const unregister = registerRenderer({
  id: 'test-chart',
  name: '测试图',
  match: /^testChart\b/i,
  normalize: (source) => source.trim().toUpperCase(),
  render: (source) => `<svg data-source="${source}"></svg>`,
});
assert.equal(detect('testChart hello')?.id, 'test-chart');
assert.deepEqual(supported().find(({ id }) => id === 'test-chart')?.fences, ['mermaid']);
assert.equal(await renderDiagram('  testChart hello  '), '<svg data-source="TESTCHART HELLO"></svg>');
assert.equal(await renderFencedDiagram('MERMAID', '  testChart hello  '), '<svg data-source="TESTCHART HELLO"></svg>');
unregister();
assert.equal(detect('testChart hello'), null);

console.log('diagram regression: ok');
