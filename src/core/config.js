/* =====================================================================
 * Docsmith · 配置中心
 * ---------------------------------------------------------------------
 * 这是整个项目里唯一需要改动就能「换一套品牌 / 换一套能力」的文件。
 * 任何人 fork 之后，改这里就够了 —— 不需要动业务代码。
 *
 * 三件事写在这里：
 *   1. BRAND        产品名、副标题、主页链接
 *   2. CAPABILITIES 侧栏内置能力（加一条配置 = 加一个能力）
 *   3. STORAGE_*    对象存储的「默认空白模板」——注意：这里不放任何
 *                   真实的服务器地址、密钥、账号。凭据一律由用户在
 *                   设置里填写，存在本机，不进代码库。
 * ===================================================================== */

/* --------------------------------------------------------------- 品牌 */
export const BRAND = {
  name: 'Docsmith',
  nameZh: '文匠',
  tagline: 'Markdown 工作台 · 卡片 · 文件库',
  /* 侧栏折叠时显示的单字标记 */
  mark: 'D',
  repo: 'https://github.com/YOUR-NAME/docsmith',
  docs: 'https://github.com/YOUR-NAME/docsmith#readme',
};

/* ----------------------------------------------------------- 存储键名 */
export const KEYS = {
  appearance: 'docsmith:appearance',   // 主题 / 强调色
  shell: 'docsmith:shell',             // 菜单顺序、隐藏项、自定义能力
  storage: 'docsmith:storage',         // 云存储配置（含凭据，仅本机）
  library: 'docsmith:library',         // 文件库：历史、分类、偏好
  prefs: 'docsmith:prefs',             // 全应用偏好：阅读排版、编辑与导出习惯
  reviewNotes: 'docsmith:review-notes', // Markdown 工作台：本地评审意见
  baselines: 'docsmith:confirmed',      // Markdown 工作台：用户确认过的版本
};

/* --------------------------------------------------------- 内置能力表 *
 * id      唯一标识，能力之间互相跳转靠它
 * name    侧栏显示名
 * desc    一句话说明它能干什么（用户视角，不写技术词）
 * url     相对扩展根目录的页面路径
 * icon    24×24 SVG 的内部路径，stroke 由主题色接管
 * needs   依赖项：'storage' 表示没配置云存储时该能力受限（不是不能用，
 *         是「上传 / 分享」这类动作会引导用户去配置）
 * ------------------------------------------------------------------ */
export const CAPABILITIES = [
  {
    id: 'markdown',
    name: 'Markdown 工作台',
    desc: '复杂内容舒服读 · 正文表格直接改 · 每处变化逐一核对',
    url: 'src/views/markdown/index.html',
    builtin: true,
    needs: [],
    icon: '<path d="M12 7.2C10.6 6.1 8.7 5.5 6.4 5.5c-.9 0-1.7.1-2.4.2A1 1 0 0 0 3 6.7v10.6a1 1 0 0 0 1.2 1c.7-.1 1.4-.2 2.2-.2 2.3 0 4.2.6 5.6 1.7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.2c1.4-1.1 3.3-1.7 5.6-1.7.9 0 1.7.1 2.4.2a1 1 0 0 1 1 1v10.6a1 1 0 0 1-1.2 1c-.7-.1-1.4-.2-2.2-.2-2.3 0-4.2.6-5.6 1.7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7.2v12.6" stroke-width="1.6" stroke-linecap="round"/><path d="M5.9 11.2h3.4" stroke-width="1.3" stroke-linecap="round" opacity=".5"/>',
  },
  {
    id: 'cards',
    name: '图文卡片',
    desc: '文字变成图 · 发小红书、抖音',
    url: 'src/views/cards/index.html',
    builtin: true,
    needs: [],
    icon: '<rect x="3.2" y="4.6" width="13" height="15" rx="2" stroke-width="1.6" stroke-linejoin="round"/><path d="M18 7.4a2 2 0 0 1 2.8 1.2l.1.5v8.6a2 2 0 0 1-1.5 2" stroke-width="1.6" stroke-linecap="round" opacity=".55"/><path d="M6.4 9.4h6.6M6.4 12.6h6.6M6.4 15.8h4" stroke-width="1.4" stroke-linecap="round" opacity=".7"/>',
  },
  {
    id: 'files',
    name: '文件库',
    desc: '上传 · 分类 · 转换格式 · 一键拿到分享链接',
    url: 'src/views/files/index.html',
    builtin: true,
    needs: ['storage'],
    icon: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" stroke-width="1.6" stroke-linejoin="round"/>',
  },
];

/* 调整上面 CAPABILITIES 的默认顺序后，把这个数字 +1。
 * 用户在「菜单管理」里存过的旧顺序会被作废一次，新顺序才生效。
 * v2：插入了「图文卡片」，老用户存的两项顺序要作废一次才能看到它。 */
export const ORDER_VERSION = 2;

/* ------------------------------------------------------- 云存储：模板 *
 * 每种服务对应一个 provider。字段定义在这里，设置界面按它自动生成表单，
 * 加一种新的云存储 = 在 src/storage/ 加一个适配器 + 在这里加一段描述。
 *
 * secret: true 的字段在界面上以密码形式显示，且不参与「导出配置」。
 * ------------------------------------------------------------------ */
export const STORAGE_PROVIDERS = [
  {
    id: 'gateway',
    name: '公司/团队的上传接口',
    summary: '如果你们公司已经有一个「上传文件」的网址，填上就能用。密码留在公司服务器上，这台电脑什么都不存，最省心。',
    /* 说明文档走内置查看器（src/views/docs/）。别直接链 .md ——
       Chrome 对 .md 不带 charset，中文会整篇乱码。 */
    docs: 'src/views/docs/index.html?doc=storage#通用上传接口',
    /* 文案原则：不假设读者知道什么是「字段」「JSON」「请求头」。
       每一条都回答两个问题：这个填什么样子的东西、我去哪儿要。
       required 的三项排在前面，advanced 的收进「高级选项」，
       让普通人只面对必填的那两三个框。 */
    fields: [
      { key: 'apiUrl', label: '上传网址', placeholder: 'https://公司服务器/api/upload', required: true,
        help: '公司给你的那个上传网址，整条粘进来。不知道就问 IT 或者给你这个接口的同事：'
            + '「我们上传文件的接口地址是什么？」' },
      { key: 'urlPath', label: '在哪取文件链接', placeholder: 'data.downUrl', default: 'data.downUrl', required: true,
        help: '上传成功后，服务器会回一段结果，文件链接藏在里面某个位置。'
            + '大多数公司的接口是 data.downUrl，先用这个试；不对就问同事「上传成功后返回的链接叫什么名字」。' },
      { key: 'extraFields', label: '还要一起带的信息', type: 'kv', advanced: true,
        placeholder: 'bucket = my-bucket\nuserCode = 你的账号',
        help: '有些公司的接口还要知道「存到哪个空间」「谁上传的」。一行写一条，等号左边是名字、右边是值。没人要求就留空。' },
      { key: 'headers', label: '登录凭证', type: 'kv', advanced: true,
        placeholder: 'Authorization = Bearer 你的令牌',
        help: '接口需要验明身份时才填，格式同上。不需要就留空。' },
      { key: 'fileField', label: '文件参数名', placeholder: 'file', default: 'file', advanced: true,
        help: '接口用哪个名字来接收文件。几乎都是 file，一般不用改。' },
    ],
  },
  {
    id: 'aliyun',
    name: '我自己的阿里云',
    summary: '你自己有阿里云账号，文件直接传进你的空间，不经过任何中转。要在阿里云控制台做三件事：建空间、建一把只能传这个空间的钥匙、开跨域。照着说明一步步来大概十分钟。',
    docs: 'src/views/docs/index.html?doc=storage#阿里云-oss',
    fields: [
      { key: 'bucket', label: '空间名字', placeholder: 'my-docsmith', required: true,
        help: '你在阿里云建的那个「Bucket」叫什么名字，原样填。' },
      { key: 'region', label: '空间在哪个地区', placeholder: 'oss-cn-hangzhou', required: true,
        help: '登录阿里云 OSS 控制台，点开你的空间，「概览」页上能看到一串 oss-cn-开头的字，照抄。'
            + '比如杭州是 oss-cn-hangzhou、上海是 oss-cn-shanghai。' },
      { key: 'accessKeyId', label: '钥匙编号', placeholder: 'LTAI 开头的一串', required: true,
        help: '阿里云管它叫 AccessKey ID，LTAI 开头。'
            + '请务必用「子账号」的钥匙、且只授权这一个空间 —— 主账号的钥匙能动你名下所有东西，泄露了麻烦很大。' },
      { key: 'accessKeySecret', label: '钥匙密码', secret: true, required: true,
        help: '阿里云管它叫 AccessKey Secret，只在创建那一刻显示一次，当时没存就只能重新建一把。'
            + '它只留在你这台电脑上，Docsmith 不会传给任何人。' },
      { key: 'acl', label: '链接给谁看', type: 'select', default: 'private',
        options: [
          { value: 'private', label: '只有拿到链接的人（链接会过期）' },
          { value: 'public-read', label: '任何人（链接一直有效）' },
        ],
        help: '选「任何人」适合长期分享；选「只有拿到链接的人」更安全，但过期后要重新生成链接。' },
      { key: 'signedExpires', label: '链接多久过期', type: 'select', default: '604800',
        options: [
          { value: '3600', label: '1 小时' },
          { value: '86400', label: '1 天' },
          { value: '604800', label: '7 天（阿里云最长只能这么久）' },
        ],
        help: '只有上面选了「只有拿到链接的人」时才有用。',
        showIf: { key: 'acl', value: 'private' } },
      { key: 'prefix', label: '存到哪个文件夹', placeholder: 'docsmith/', default: 'docsmith/', advanced: true,
        help: '文件都会放进空间里的这个文件夹，跟你其他文件分开，好找。一般不用改。' },
      { key: 'customDomain', label: '自己的域名', placeholder: 'https://files.example.com', advanced: true,
        help: '给空间绑过自己的域名或 CDN 才填，生成的链接会用它。留空就用阿里云默认地址。' },
      { key: 'stsToken', label: '临时令牌', secret: true, advanced: true,
        help: '公司发的是临时凭证时才填。自己建的钥匙不用管，留空。' },
    ],
  },
];

/* 新装用户默认选中的服务。改成 'aliyun' 可让阿里云成为默认。 */
export const DEFAULT_PROVIDER = 'gateway';

/* --------------------------------------------------- 强调色可选调色板 */
export const ACCENTS = [
  { id: 'blue',   color: '#533afd', label: '靛蓝' },
  { id: 'violet', color: '#7c3aed', label: '紫罗兰' },
  { id: 'cyan',   color: '#0e7490', label: '深青' },
  { id: 'green',  color: '#067647', label: '松绿' },
  { id: 'amber',  color: '#b45309', label: '琥珀' },
  { id: 'pink',   color: '#ea2261', label: '玫红' },
];
