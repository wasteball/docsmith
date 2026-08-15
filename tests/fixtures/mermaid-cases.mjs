export const sequenceLongMessagesWithNotes = `sequenceDiagram
    participant A as AI
    participant U as 用户
    A->>U: ①「您好，我是美弟安得智联客服，您购买的空调等商品，<br/>我们预计在后天派送，请问您方便吗？」
    Note right of A: ❌ P0 品牌名念错「美弟」应为「美的」<br/>❌ P2 首句 4 个信息点，「空调等商品」含糊
    U->>A: ②「哎。」
    Note left of U: ❌ 核心意图/知识库意图/实体 全部未识别<br/>短应答词未纳入有效应答，浪费一轮
    U->>A: ③「方便。」→ 核心意图:[方便]
    Note left of U: ⚠️ 节点跳转至「预约成功结束地址核对」<br/>🔵 成功标记时点存疑（见问题 10）
    A->>U: ④「好的，我们预计在 2026-08-16 星期日给您派送，<br/>请问需要给您当天安装好吗？」
    U->>A: ⑤「第2。」→ 全部未识别
    Note left of U: ❌ P1 ASR 识别错误<br/>❌ P1 CaseType（送装一体）未获有效回答即跳过
    A->>U: ⑥「好的，我们预计在 2026-08-16 星期日给您派送，<br/>请问您的地址是吉林省松原市长岭县长岭镇，对吗？」
    Note right of A: ❌ P2 重试重播整句，日期播报第二遍<br/>拉长通话时长（0.073 元/分钟计费）
    U->>A: ⑦「买那个。」→ 全部未识别
    Note left of U: ❌ P1 疑为「是那个 / 对，那个」的 ASR 错误
    U->>A: ⑧「长岭县长岭镇。」→ 核心意图:【挂机意图】修改地址
    Note left of U: 🔴 P0 核心问题：这是播报地址的完全子串<br/>用户在复述确认，被判成修改地址
    A->>U: ⑨「好的，已收到您的反馈，我们转人工客服跟您核对地址，<br/>祝您生活愉快，再见。」
    Note right of A: 🔴 P0 无澄清轮，单轮误判直接挂机<br/>P1 与文档口径「话术应解释派送时核实地址」不一致`;

export const flowchartSixSiblingSubgraphs = `flowchart TB
    subgraph 接入层
    U1[运营配置后台]
    U2[质检工作台]
    U3[数据看板]
    end

    subgraph 业务层
    B1[名单管理服务]
    B2[任务调度服务]
    B3[合规管控服务]
    B4[结果打标服务]
    end

    subgraph 对话层
    D1[会话编排引擎]
    D2[NLU 语义理解服务]
    D3[LLM 兜底服务]
    D4[知识检索服务]
    D5[话术与流程配置中心]
    end

    subgraph 能力层
    C1[ASR 语音识别]
    C2[TTS 语音合成]
    C3[VAD 语音活动检测]
    C4[内容安全检测]
    end

    subgraph 通信层
    T1[外呼网关]
    T2[号码池管理]
    T3[线路路由]
    end

    subgraph 外部系统
    E1[MDM 客户主数据]
    E2[保单核心系统]
    E3[CRM 线索系统]
    E4[坐席呼叫中心]
    E5[短信与企业微信]
    end

    U1 --> B1
    U1 --> B2
    U1 --> D5
    U2 --> B4
    B1 --> B3
    B2 --> B3
    B3 --> T1
    T1 --> T2
    T1 --> T3
    T1 --> D1
    D1 --> D2
    D2 --> D3
    D1 --> D4
    D1 --> D5
    D1 --> C1
    D1 --> C2
    D1 --> C3
    D3 --> C4
    D1 --> B4
    B3 --> E1
    B1 --> E2
    B4 --> E3
    D1 --> E4
    B4 --> E5`;

export const mermaidCaseExpectations = {
  sequence: { actors: 2, messages: 9, notes: 8 },
  flowchart: { groups: 6, nodes: 24, rootGroups: ['__group_0', '__group_1', '__group_2', '__group_3', '__group_4', '__group_5'] },
};
