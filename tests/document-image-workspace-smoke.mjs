const transparent = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=';
const longRows = Array.from({length:80},(_,i)=>`| 第 ${i+1} 行 | 内容 ${'长文本'.repeat(5)} |`).join('\n');
const source = `# 整篇图片回归

> [!NOTE]\n> 图片应保留当前阅读排版、主题和图表。

![内嵌图片](${transparent})

## 列表

1. 第一项
2. 第二项
3. 第三项

## 表格

| 序号 | 内容 |
|---:|---|
${longRows}

## 图表

\`\`\`mermaid
flowchart LR
  A["<b>粗体</b><br/><i>斜体</i>"] --> B["完整 PNG"]
\`\`\`

## 信息图

\`\`\`infographic
infographic list-row-horizontal-icon-arrow
data
  title 客户增长引擎
  desc 多渠道触达与复购提升
  items
    - label 线索获取
      value 18.6
      desc 渠道投放与内容获客
      icon rocket-launch
    - label 转化提效
      value 12.4
      desc 线索评分与自动跟进
      icon progress-check
    - label 复购提升
      value 9.8
      desc 会员体系与权益运营
      icon account-sync
    - label 口碑传播
      value 6.2
      desc 社群激励与推荐裂变
      icon account-group
\`\`\`

## 公式

$$\\int_0^1 x^2 \\,dx = \\frac{1}{3}$$

## 代码

\`\`\`js
const answer = 42;
console.log(answer);
\`\`\``;
const fail=(message)=>{window.__documentImageSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DocsmithDocumentImage&&win.modernScreenshot){run();return}if(Date.now()-started>20000)return fail('工作台或图片运行时没有启动');setTimeout(wait,60)})();
  async function run(){try{
    win.MDW.setText(source);
    await win.MDW.whenDiagramsReady({timeout:30000,requireSuccess:true});
    const original=win.MDW.getDoc().text;
    const diagramBlocks=[...doc.querySelectorAll('.diagram-block')];
    const mermaidBlock=diagramBlocks.find(block=>block.dataset.diagramLanguage==='mermaid');
    const infographicBlock=diagramBlocks.find(block=>block.dataset.diagramLanguage==='infographic');
    const mermaidSvg=mermaidBlock&&mermaidBlock.querySelector('.mm-stage svg');
    const infographicSvg=infographicBlock&&infographicBlock.querySelector('.mm-stage svg');
    if(!mermaidSvg||mermaidSvg.querySelector('foreignObject'))throw new Error('Mermaid 纯 SVG 前置条件错误');
    if(!infographicSvg)throw new Error('Infographic 没有挂载');
    const infographicText=['客户增长引擎','多渠道触达与复购提升','线索获取 · 18.6','转化提效 · 12.4','复购提升 · 9.8','口碑传播 · 6.2'];
    const originalForeignObjects=infographicSvg.querySelectorAll('foreignObject').length;
    if(originalForeignObjects!==10||!infographicText.every(x=>(infographicSvg.textContent||'').includes(x)))throw new Error('Infographic 文本前置条件错误');
    if(infographicSvg.querySelectorAll('[data-element-type=item-icon]').length!==4)throw new Error('Infographic 图标前置条件错误');
    const katex=doc.querySelector('.katex');const highlighted=doc.querySelector('code.hljs');
    if(!katex||!highlighted||!highlighted.querySelector('.hljs-keyword'))throw new Error('公式或代码高亮前置条件错误');
    const captureChecks=[],stripStructures=[];
    const originalDomToBlob=win.modernScreenshot.domToBlob;
    win.modernScreenshot.domToBlob=async function(page,options){
      const diagram=page.querySelector('.diagram-block[data-diagram-language=infographic] svg');
      stripStructures.push({
        height:Math.round(page.getBoundingClientRect().height),
        top:Math.abs(parseFloat(page.querySelector('.doc-image-article')?.style.top||'0')),
        tableRows:page.querySelectorAll('table tbody tr').length
      });
      let geometry=null;
      const pageRect=page.getBoundingClientRect(),pageKatex=page.querySelector('.katex'),pageCode=page.querySelector('code.hljs');
      const visibleTop=pageRect.top,visibleBottom=pageRect.bottom;
      const inStrip=rect=>rect.bottom>visibleTop&&rect.top<visibleBottom;
      if(diagram){
        const spans=[...diagram.querySelectorAll('foreignObject>span')];
        const icons=[...diagram.querySelectorAll('[data-element-type=item-icon]')];
        geometry={
          texts:spans.map(el=>({text:el.textContent.trim(),rect:el.getBoundingClientRect()})).filter(x=>inStrip(x.rect)),
          icons:icons.map(el=>el.getBoundingClientRect()).filter(inStrip),
          pageRect
        };
        if(spans.length!==10||icons.length!==4||!infographicText.every(x=>(diagram.textContent||'').includes(x)))throw new Error('捕获副本丢失 Infographic 文本或图标');
      }
      const blob=await originalDomToBlob.call(this,page,options);
      if(geometry){
        const bitmap=await win.createImageBitmap(blob),scale=Number(options.scale)||1;
        const canvas=doc.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
        const probe=doc.createElement('canvas').getContext('2d');probe.fillStyle=options.backgroundColor||'#fff';probe.fillRect(0,0,1,1);
        const bg=probe.getImageData(0,0,1,1).data;
        function hasInk(rect){
          const x=Math.max(0,Math.floor((rect.left-geometry.pageRect.left)*scale));
          const y=Math.max(0,Math.floor((rect.top-geometry.pageRect.top)*scale));
          const w=Math.max(1,Math.min(canvas.width-x,Math.ceil(rect.width*scale)));
          const h=Math.max(1,Math.min(canvas.height-y,Math.ceil(rect.height*scale)));
          if(x>=canvas.width||y>=canvas.height||w<1||h<1)return false;
          const data=ctx.getImageData(x,y,w,h).data;let ink=0;
          for(let i=0;i<data.length;i+=16){if(data[i+3]>0&&Math.max(Math.abs(data[i]-bg[0]),Math.abs(data[i+1]-bg[1]),Math.abs(data[i+2]-bg[2]))>14&&++ink>2)return true}
          return false;
        }
        captureChecks.push({texts:geometry.texts.map(x=>({text:x.text,ink:hasInk(x.rect)})),icons:geometry.icons.map(hasInk),katex:pageKatex&&inStrip(pageKatex.getBoundingClientRect())?hasInk(pageKatex.getBoundingClientRect()):null,code:pageCode&&inStrip(pageCode.getBoundingClientRect())?hasInk(pageCode.getBoundingClientRect()):null});
      }else if(pageKatex||pageCode){
        const bitmap=await win.createImageBitmap(blob),scale=Number(options.scale)||1,canvas=doc.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(bitmap,0,0);bitmap.close();
        const probe=doc.createElement('canvas').getContext('2d');probe.fillStyle=options.backgroundColor||'#fff';probe.fillRect(0,0,1,1);const bg=probe.getImageData(0,0,1,1).data;
        function hasInk(rect){const x=Math.max(0,Math.floor((rect.left-pageRect.left)*scale)),y=Math.max(0,Math.floor((rect.top-pageRect.top)*scale)),w=Math.max(1,Math.min(canvas.width-x,Math.ceil(rect.width*scale))),h=Math.max(1,Math.min(canvas.height-y,Math.ceil(rect.height*scale)));if(x>=canvas.width||y>=canvas.height||w<1||h<1)return false;const data=ctx.getImageData(x,y,w,h).data;let ink=0;for(let i=0;i<data.length;i+=16){if(data[i+3]>0&&Math.max(Math.abs(data[i]-bg[0]),Math.abs(data[i+1]-bg[1]),Math.abs(data[i+2]-bg[2]))>14&&++ink>2)return true}return false}
        captureChecks.push({texts:[],icons:[],katex:pageKatex&&inStrip(pageKatex.getBoundingClientRect())?hasInk(pageKatex.getBoundingClientRect()):null,code:pageCode&&inStrip(pageCode.getBoundingClientRect())?hasInk(pageCode.getBoundingClientRect()):null});
      }
      return blob;
    };
    const one=await win.MDW.buildDocumentImages();
    if(one.mode!=='single'||one.blob.type!=='image/png'||one.blob.size<1000)throw new Error('没有生成一张有效 PNG');
    if(!one.filename.endsWith('.png')||/-\d{2}\.png$/.test(one.filename))throw new Error('最终文件仍带分页编号：'+one.filename);
    const bitmap=await win.createImageBitmap(one.blob);const decoded=[bitmap.width,bitmap.height];
    if(bitmap.width!==one.width||bitmap.height!==one.height)throw new Error('PNG 元数据与真实尺寸不一致');
    if(!(one.height>8192)||stripStructures.length<2)throw new Error('长文没有通过内部条带生成一张长图：'+one.height+'/'+stripStructures.length);
    bitmap.close();
    const expectedTops=[];let accumulated=0;for(const strip of stripStructures){expectedTops.push(accumulated);accumulated+=strip.height}
    if(stripStructures.some((strip,index)=>Math.abs(strip.top-expectedTops[index])>1))throw new Error('内部条带边界不连续：'+JSON.stringify(stripStructures));
    const liveRows=[...doc.querySelectorAll('table tbody tr')].map(x=>x.textContent.trim());
    if(liveRows.length!==80||new Set(liveRows).size!==80||!liveRows[0].includes('第 1 行')||!liveRows.at(-1).includes('第 80 行'))throw new Error('长图源表格有丢失或重复');
    if(win.MDW.getDoc().text!==original)throw new Error('生成图片改写了 Markdown');
    if(doc.querySelectorAll('.doc-image-capture').length)throw new Error('临时捕获节点没有清理');
    if(mermaidSvg.querySelector('foreignObject'))throw new Error('生成后 Mermaid 留下 foreignObject');
    if(infographicSvg.querySelectorAll('foreignObject').length!==originalForeignObjects)throw new Error('生成图片改写了 Infographic');
    if(!captureChecks.length||!captureChecks.some(check=>check.texts.length)||!captureChecks.some(check=>check.icons.length)||captureChecks.some(check=>check.texts.some(x=>!x.ink)||check.icons.some(x=>!x)))throw new Error('PNG 中 Infographic 文本或图标区域为空白');
    if(!captureChecks.some(check=>check.katex===true)||!captureChecks.some(check=>check.code===true))throw new Error('PNG 中公式或高亮代码为空白');
    let failed=false;win.MDW.setText('# 失败关闭\n\n![坏图](data:text/plain,not-an-image)');
    await new Promise(r=>setTimeout(r,150));
    try{await win.MDW.buildDocumentImages()}catch(e){failed=/图片|image|资源/.test(String(e&&e.message))}
    if(!failed)throw new Error('坏图片没有让整次生成失败');
    if(doc.querySelectorAll('.doc-image-capture').length)throw new Error('失败后临时捕获节点没有清理');
    win.modernScreenshot.domToBlob=originalDomToBlob;
    window.__documentImageSmoke={ready:true,images:1,filename:one.filename,width:one.width,height:one.height,internalStrips:stripStructures.length,scale:one.scale,decoded,limits:{stripSide:one.maxSide,stripPixels:one.maxPixels},sourceUnchanged:true,mermaidForeignObject:false,infographicForeignObjects:originalForeignObjects,infographicRasterized:true,captureRuns:captureChecks.length,katexRasterized:true,highlightRasterized:true,tableRowsComplete:true,stripBoundariesContinuous:true,cleanup:true,failClosed:true};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__documentImageSmoke);
  }catch(error){fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
