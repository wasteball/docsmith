const fail=(message)=>{window.__documentImageLayoutSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DocsmithDocumentImage&&win.modernScreenshot){run();return}if(Date.now()-started>20000)return fail('工作台或图片运行时没有启动');setTimeout(wait,60)})();
  async function run(){try{
    const longCode=Array.from({length:430},(_,i)=>`const row_${i+1} = "line-${i+1}";`).join('\n');
    const list=Array.from({length:240},(_,i)=>`${i+1}. 第 ${i+1} 项 ${'连续编号'.repeat(5)}`).join('\n');
    const source=`# 布局边界\n\n## 超长代码\n\n\`\`\`js\n${longCode}\n\`\`\`\n\n## 跨页列表\n\n${list}\n\n## 图表\n\n\`\`\`mermaid\nflowchart LR\n  A[完整图表] --> B[图片]\n\`\`\``;
    win.MDW.setText(source);await win.MDW.whenDiagramsReady({timeout:30000,requireSuccess:true});
    const liveBlock=doc.querySelector('.diagram-block');liveBlock.dataset.view='source';
    const liveStage=liveBlock.querySelector('.mm-stage');liveStage.style.transform='translate(250px, 150px) scale(2.4)';
    const stateAfterReady={view:liveBlock.dataset.view,transform:liveStage.style.transform};
    const hugeBlock=doc.createElement('div');hugeBlock.className='blk';hugeBlock.dataset.btype='paragraph';const hugeImg=doc.createElement('img');hugeImg.alt='oversize';hugeImg.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+0KHnWQAAAABJRU5ErkJggg==';hugeImg.style.width='800px';hugeImg.style.height='7000px';hugeBlock.appendChild(hugeImg);win.MDW.getPreviewRoot().insertBefore(hugeBlock,liveBlock.closest('.blk'));
    await hugeImg.decode();
    const strips=[];const original=win.modernScreenshot.domToBlob;
    win.modernScreenshot.domToBlob=async(strip,options)=>{
      const article=strip.querySelector('.doc-image-article');
      const diagrams=[...strip.querySelectorAll('.diagram-block')];
      strips.push({
        top:Math.abs(parseFloat(article?.style.top||'0')),
        height:strip.getBoundingClientRect().height,
        olItems:strip.querySelectorAll('ol>li').length,
        hasFirstCode:strip.textContent.includes('line-1'),
        hasLastCode:strip.textContent.includes('line-430'),
        oversize:[...strip.querySelectorAll('img[alt=oversize]')].map(x=>x.getBoundingClientRect().height),
        diagram:diagrams.map(x=>({view:x.dataset.view,sourceDisplay:x.querySelector('.diagram-source')?.style.display,stage:x.querySelector('.mm-stage')?.style.transform||''}))
      });
      return original.call(this,strip,options);
    };
    const one=await win.MDW.buildDocumentImages();
    const firstCount=strips.length;
    const two=await win.MDW.buildDocumentImages();
    win.modernScreenshot.domToBlob=original;
    if(one.mode!=='single'||two.mode!=='single'||one.filename!==two.filename)throw new Error('重复生成没有保持单图合同');
    if(one.width!==two.width||one.height!==two.height)throw new Error('重复生成的长图尺寸不稳定');
    const firstRun=strips.slice(0,firstCount),secondRun=strips.slice(firstCount);
    if(firstRun.length<3||secondRun.length!==firstRun.length)throw new Error('内部条带数量不稳定：'+firstRun.length+'/'+secondRun.length);
    function assertContinuous(rows){let top=0;for(const row of rows){if(Math.abs(row.top-top)>1)throw new Error('内部条带有空隙或重叠：'+JSON.stringify(rows));top+=row.height}if(Math.abs(top-one.height/one.scale)>2)throw new Error('内部条带没有覆盖完整文档：'+top)}
    assertContinuous(firstRun);assertContinuous(secondRun);
    if(!firstRun.some(x=>x.hasFirstCode)||!firstRun.some(x=>x.hasLastCode))throw new Error('超长代码首尾没有进入长图条带');
    if(!firstRun.some(x=>x.olItems===240))throw new Error('有序列表没有完整进入长图条带');
    const oversize=firstRun.flatMap(x=>x.oversize);if(!oversize.length||oversize.some(x=>x<6900))throw new Error('长图不应缩小超高正文图片：'+JSON.stringify(oversize));
    const diagram=firstRun.flatMap(x=>x.diagram)[0];
    if(!diagram||diagram.view!=='diagram'||diagram.sourceDisplay!=='none'||diagram.stage!=='none')throw new Error('图表没有强制回成完整 diagram：'+JSON.stringify(diagram));
    if(liveBlock.dataset.view!==stateAfterReady.view)throw new Error('捕获改写了在线图表视图：'+liveBlock.dataset.view);
    if(liveStage.style.transform==='none')throw new Error('捕获把在线图表 transform 清成 none');
    if(doc.querySelector('.doc-image-capture'))throw new Error('布局测试后捕获节点没有清理');
    window.__documentImageLayoutSmoke={ready:true,images:1,width:one.width,height:one.height,internalStrips:firstRun.length,stable:true,orderedListItems:240,longCode:true,oversizePreserved:true,stripBoundariesContinuous:true,diagramNormalized:true,liveStateUnchanged:true};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__documentImageLayoutSmoke);
  }catch(error){fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
