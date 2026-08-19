const reported = `gantt
    title 项目里程碑
    dateFormat YYYY-MM-DD
    axisFormat %m/%d
    section 决策
    BRD评审与立项          :milestone, m1, 2026-02-16, 0d
    section 设计
    合规评估完成           :a1, 2026-02-14, 4d
    PRD评审通过            :milestone, m2, 2026-02-25, 0d
    section 建设
    系统建设与集成         :b1, 2026-02-25, 14d
    section 验证
    内部拨测               :c1, 2026-03-10, 3d
    灰度500通              :c2, 2026-03-13, 2d
    灰度1500通             :c3, 2026-03-20, 3d
    中量5000通             :c4, 2026-03-28, 4d
    section 上线
    全量上线               :milestone, m3, 2026-03-31, 0d
    效果首次读数           :milestone, m4, 2026-05-12, 0d
    三个月复盘             :milestone, m5, 2026-07-01, 0d`;

const markerOff = reported.replace('    axisFormat %m/%d', '    axisFormat %m/%d\n    todayMarker off');
const inRange = `gantt
    title 状态与域内今天线
    dateFormat YYYY-MM-DD
    axisFormat %m/%d
    section 验证
    已完成                 :done, a1, 2026-08-01, 7d
    进行中                 :active, a2, 2026-08-08, 15d
    关键任务               :crit, a3, 2026-08-15, 12d
    普通任务               :a4, 2026-08-22, 10d
    域内里程碑             :milestone, m1, 2026-08-19, 0d`;
const styled = reported.replace('    axisFormat %m/%d', '    axisFormat %m/%d\n    todayMarker stroke:#0066ff,stroke-width:4px');
const cases = [reported, markerOff, inRange, styled];
const source = `# Mermaid Gantt 今天线回归\n\n${cases.map((value)=>`\`\`\`mermaid\n${value}\n\`\`\``).join('\n\n')}`;

const fail = (message) => {
  window.__ganttTodaySmoke = { error: String(message) };
  document.body.dataset.rendered = 'error';
  document.title = String(message);
};
const finite = (value) => Number.isFinite(Number(value));
const box = (vb) => ({ x: vb.x, y: vb.y, width: vb.width, height: vb.height, right: vb.x + vb.width, bottom: vb.y + vb.height });
const containsBBox = (svg) => {
  const vb=box(svg.viewBox.baseVal),bb=svg.getBBox(),e=2;
  return bb.x>=vb.x-e&&bb.y>=vb.y-e&&bb.x+bb.width<=vb.right+e&&bb.y+bb.height<=vb.bottom+e;
};

const frame=document.createElement('iframe'); frame.id='workspace'; frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{
  const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){
    if(win.MDW&&win.DocsmithDiagrams){run();return;}
    if(Date.now()-started>20000)return fail('工作台没有启动');
    setTimeout(wait,60);
  })();

  async function run(){
    try{
      if(!win.DocsmithDiagrams.hasOfficialMermaid||win.mermaid?.__docsmith)throw new Error('官方 Mermaid 没有启用');
      const RealDate=win.Date;
      const fixed=new RealDate('2026-08-19T12:00:00+08:00').valueOf();
      function FakeDate(...args){
        if(new.target)return args.length?new RealDate(...args):new RealDate(fixed);
        return args.length?RealDate(...args):RealDate(fixed);
      }
      FakeDate.prototype=RealDate.prototype;
      Object.setPrototypeOf(FakeDate,RealDate);
      FakeDate.now=()=>fixed; FakeDate.parse=RealDate.parse; FakeDate.UTC=RealDate.UTC;
      win.Date=FakeDate;

      const config={startOnLoad:false,securityLevel:'strict',htmlLabels:false,suppressErrorRendering:true,fontFamily:'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',flowchart:{htmlLabels:false,useMaxWidth:false}};
      win.mermaid.initialize(config);
      const rawResult=await win.mermaid.render('gantt-today-upstream-baseline',reported);
      const rawDoc=new win.DOMParser().parseFromString(rawResult.svg,'image/svg+xml');
      const rawSvg=rawDoc.documentElement,rawVb=box(rawSvg.viewBox.baseVal),rawLine=rawSvg.querySelector('g.today > line.today');
      if(!rawLine||rawLine.hasAttribute('style'))throw new Error('官方 Mermaid 基线没有生成无样式默认今天线');
      const rawX1=Number(rawLine.getAttribute('x1')),rawX2=Number(rawLine.getAttribute('x2'));
      if(!finite(rawX1)||!finite(rawX2)||Math.min(rawX1,rawX2)<=rawVb.right)throw new Error('官方 Mermaid 基线未复现域外今天线');
      rawSvg.remove();

      win.MDW.setText(source);
      await win.MDW.whenDiagramsReady({timeout:50000,requireSuccess:true});
      const blocks=[...doc.querySelectorAll('.diagram-block')],svgs=blocks.map((block)=>block.querySelector('.mm-stage > svg'));
      if(blocks.length!==4||svgs.some((svg)=>!svg))throw new Error('四个 Gantt 控制用例没有全部渲染');
      if(svgs.some((svg)=>svg.classList.contains('dg')||(svg.getAttribute('aria-roledescription')||'').toLowerCase()!=='gantt'))throw new Error('Gantt 没有走官方渲染路径');
      blocks.forEach((block,index)=>{if(block.querySelector('.diagram-source code').textContent!==cases[index])throw new Error('第 '+(index+1)+' 个 Mermaid 源码被改写');});
      if(win.MDW.getDoc().text!==source)throw new Error('原始 Markdown 被改写');

      const exact=svgs[0],off=svgs[1],inside=svgs[2],explicit=svgs[3];
      if(exact.querySelector('g.today > line.today'))throw new Error('域外默认今天线仍然存在');
      if(exact.querySelector('foreignObject'))throw new Error('Gantt 出现 foreignObject');
      const exactVb=box(exact.viewBox.baseVal),exactBb=exact.getBBox();
      if(!containsBBox(exact))throw new Error('修正后的 Gantt 内容超出 viewBox');
      if(exactVb.right>=rawX1-0.01)throw new Error('最终 viewBox 仍被域外今天线扩大');
      if(exactVb.width>=rawX1-rawVb.x)throw new Error('最终 Gantt 仍保留巨大右侧空白');
      if(!['项目里程碑','BRD评审与立项','三个月复盘'].every((text)=>exact.textContent.includes(text)))throw new Error('用户 Gantt 标题/任务/里程碑丢失');
      const vp=blocks[0].querySelector('.mm-viewport'),pz=vp&&vp.__pz;
      if(!pz||!(pz.scale>0))throw new Error('修正后的 Gantt pan/zoom 没有初始化');
      const vr=vp.getBoundingClientRect();
      if(exactBb.height*pz.scale-vr.height>30)throw new Error('viewport fit 没有使用修正后的尺寸');

      if(off.querySelector('g.today > line.today'))throw new Error('todayMarker off 仍然生成今天线');
      const insideLine=inside.querySelector('g.today > line.today');
      if(!insideLine||insideLine.hasAttribute('style'))throw new Error('域内默认今天线被误删或改写');
      const insideVb=box(inside.viewBox.baseVal),insideX=Number(insideLine.getAttribute('x1'));
      if(!finite(insideX)||insideX<insideVb.x||insideX>insideVb.right)throw new Error('域内今天线不在最终边界内');
      if(!['已完成','进行中','关键任务','普通任务','域内里程碑'].every((text)=>inside.textContent.includes(text)))throw new Error('状态/里程碑控制图文本丢失');
      const statusClasses=['done','active','crit'];
      statusClasses.forEach((name)=>{if(!inside.querySelector('.task[class*="'+name+'"], .taskText[class*="'+name+'"]'))throw new Error('Gantt 状态类丢失：'+name);});
      if(!inside.querySelector('.milestone'))throw new Error('Gantt milestone 类丢失');
      const statusColors=new Set([...inside.querySelectorAll('.task,.task2,.task3,.task4')].map((node)=>win.getComputedStyle(node).fill));
      if(statusColors.size<2)throw new Error('Gantt 状态颜色丢失');

      const explicitLine=explicit.querySelector('g.today > line.today');
      if(!explicitLine||!explicitLine.hasAttribute('style'))throw new Error('显式域外 todayMarker 被误删');
      const explicitStyle=(explicitLine.getAttribute('style')||'').replace(/\s/g,'').toLowerCase();
      if(!explicitStyle.includes('stroke:#0066ff')||!explicitStyle.includes('stroke-width:4px'))throw new Error('显式 todayMarker 样式丢失：'+explicitStyle);
      const computed=win.getComputedStyle(explicitLine);
      if(computed.stroke!=='rgb(0, 102, 255)'||computed.strokeWidth!=='4px')throw new Error('显式 todayMarker 计算样式错误');

      svgs.forEach((svg,index)=>{if(!containsBBox(svg))throw new Error('第 '+(index+1)+' 张 Gantt 内容超出 viewBox');if(svg.querySelector('foreignObject'))throw new Error('第 '+(index+1)+' 张 Gantt 出现 foreignObject');});

      const fullButton=blocks[0].querySelector('button[data-z="full"]');
      fullButton.click();
      await new Promise((resolve)=>win.requestAnimationFrame(()=>win.requestAnimationFrame(resolve)));
      const fullSvg=doc.querySelector('.overlay.open .mm-stage > svg');
      if(!fullSvg||fullSvg.getAttribute('viewBox')!==exact.getAttribute('viewBox')||fullSvg.querySelector('g.today > line.today'))throw new Error('全屏没有继承修正后的 Gantt SVG');
      doc.querySelector('.overlay.open .overlay-close')?.click();

      const html=await win.MDW.buildStandaloneHtml();
      const exported=new win.DOMParser().parseFromString(html,'text/html'),exportedSvgs=[...exported.querySelectorAll('.diagram-block .mm-stage > svg')];
      if(exportedSvgs.length!==4||exportedSvgs[0].querySelector('g.today > line.today')||exportedSvgs[1].querySelector('g.today > line.today'))throw new Error('独立 HTML 没有保留默认/off marker 状态');
      if(!exportedSvgs[2].querySelector('g.today > line.today')||!exportedSvgs[3].querySelector('g.today > line.today[style]'))throw new Error('独立 HTML 没有保留域内/显式 marker');
      if(exportedSvgs.some((svg)=>svg.querySelector('foreignObject')))throw new Error('独立 HTML 出现 foreignObject');

      const copy=blocks[0].querySelector('.mm-copy');
      copy.dispatchEvent(new win.PointerEvent('pointerover',{bubbles:true}));
      const pngPromise=blocks[0]._pngPromise || (blocks[0]._pngReady && Promise.resolve(blocks[0]._pngReady));
      if(!pngPromise)throw new Error('PNG 没有开始预热');
      const png=await Promise.race([pngPromise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PNG 生成超时')),15000))]);
      if(!png||!png.blob||png.blob.size<100||!(png.w>0&&png.h>0))throw new Error('修正后的 Gantt PNG 无效');
      const svgRatio=exactVb.width/exactVb.height,pngRatio=png.w/png.h;
      if(Math.abs(svgRatio-pngRatio)>0.03)throw new Error('PNG 长宽比没有继承修正后的 viewBox');

      const result={ready:true,official:true,fixedDate:new RealDate(fixed).toISOString(),baseline:{viewBox:rawVb,todayX:rawX1,outOfRange:true},exact:{todayRemoved:true,viewBox:exactVb,bbox:{x:exactBb.x,y:exactBb.y,width:exactBb.width,height:exactBb.height},fitScale:pz.scale},off:true,inRange:{todayPreserved:true,x:insideX,statusColors:statusColors.size},styled:{preserved:true,style:explicitLine.getAttribute('style')},fullscreen:true,standalone:true,png:{w:png.w,h:png.h,size:png.blob.size},security:{foreignObject:false},sourceUnchanged:true};
      window.__ganttTodaySmoke=result; document.body.dataset.rendered='true'; document.title=JSON.stringify(result);
    }catch(error){fail(error.message||error);}
  }
});
document.querySelector('#mount').append(frame);
