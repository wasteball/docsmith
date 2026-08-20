const fixtureUrl = new URLSearchParams(location.search).get('fixture') || './.exact-document-image-fixture.md';
const fail=message=>{window.__documentImageExactSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DocsmithDocumentImage&&win.modernScreenshot){run();return}if(Date.now()-started>20000)return fail('工作台或图片运行时没有启动');setTimeout(wait,60)})();
  async function run(){try{
    const response=await fetch(fixtureUrl,{cache:'no-store'});if(!response.ok)throw new Error('真实 Markdown fixture 读取失败：HTTP '+response.status);
    const source=await response.text();if(!source.includes('# AI 产品经理四大流程实战手册')||!source.includes('红 `#fce8e6` = 异常/兜底/风险'))throw new Error('真实 Markdown fixture 首尾标记不完整');
    win.MDW.setText(source);await win.MDW.whenDiagramsReady({timeout:60000,requireSuccess:true});
    const preview=win.MDW.getPreviewRoot(),before=win.MDW.getDoc().text;
    const firstBlock=preview.firstElementChild,lastBlock=preview.lastElementChild;
    if(!firstBlock||!lastBlock)throw new Error('真实文档没有渲染完整块结构');
    const stripGeometry=[];const original=win.modernScreenshot.domToBlob;
    win.modernScreenshot.domToBlob=async(strip,options)=>{
      const article=strip.querySelector('.doc-image-article');
      stripGeometry.push({top:Math.abs(parseFloat(article?.style.top||'0')),height:strip.getBoundingClientRect().height});
      return original.call(this,strip,options);
    };
    const result=await win.MDW.buildDocumentImages();win.modernScreenshot.domToBlob=original;
    if(result.mode!=='single'||result.blob.type!=='image/png'||result.filename!=='document.png')throw new Error('真实文档没有返回单 PNG 合同');
    if(result.width!==1720||result.height<=60000||stripGeometry.length<8)throw new Error('真实长文没有走完整条带路径：'+result.width+'×'+result.height+' / '+stripGeometry.length);
    let top=0;for(const strip of stripGeometry){if(Math.abs(strip.top-top)>1)throw new Error('真实长文内部条带有空隙或重叠：'+JSON.stringify(stripGeometry));top+=strip.height}
    if(Math.abs(top-result.height/result.scale)>2)throw new Error('真实长文条带没有覆盖最终高度：'+top+' / '+result.height/result.scale);
    const bitmap=await win.createImageBitmap(result.blob);if(bitmap.width!==result.width||bitmap.height!==result.height)throw new Error('真实长图解码尺寸与合同不一致');
    /* 最终图高于浏览器 Canvas 单边上限，验证时也不能反过来分配一个全高
       Canvas。只把目标区域裁进最多 1024px 高的小画布，和生产实现保持同样
       的低峰值内存边界。 */
    const sample=doc.createElement('canvas');sample.width=result.width;const sampleCtx=sample.getContext('2d',{willReadFrequently:true});
    const probe=doc.createElement('canvas').getContext('2d');probe.fillStyle=getComputedStyle(preview).getPropertyValue('--doc-bg').trim()||'#fff';probe.fillRect(0,0,1,1);const bg=probe.getImageData(0,0,1,1).data;
    function bandSignatures(y,height){
      y=Math.max(0,Math.min(bitmap.height-1,Math.floor(y)));height=Math.max(1,Math.min(1024,Math.floor(height),bitmap.height-y));
      sample.height=height;sampleCtx.clearRect(0,0,sample.width,height);sampleCtx.drawImage(bitmap,0,y,bitmap.width,height,0,0,sample.width,height);
      const pixels=sampleCtx.getImageData(0,0,sample.width,height).data,rows=[];
      for(let row=0;row<height;row++){let ink=0,sum=0;const from=row*sample.width*4,to=from+sample.width*4;for(let x=from;x<to;x+=16){const delta=Math.max(Math.abs(pixels[x]-bg[0]),Math.abs(pixels[x+1]-bg[1]),Math.abs(pixels[x+2]-bg[2]));if(pixels[x+3]&&delta>12){ink++;sum=(sum+pixels[x]*3+pixels[x+1]*5+pixels[x+2]*7+x-from)>>>0}}rows.push({ink,sum})}
      return rows;
    }
    const seams=[];let pixelTop=0;for(let i=0;i<stripGeometry.length-1;i++){
      pixelTop+=Math.round(stripGeometry[i].height*result.scale);const rows=bandSignatures(pixelTop-512,1024),nonBlank=rows.filter(x=>x.ink).length,unique=new Set(rows.filter(x=>x.ink).map(x=>x.ink+':'+x.sum)).size;
      seams.push({y:pixelTop,nonBlank,unique});
    }
    const topRows=bandSignatures(0,1024),bottomRows=bandSignatures(result.height-4096,4096);
    const topInk=topRows.some(x=>x.ink),bottomInk=bottomRows.some(x=>x.ink);
    if((!topInk||!bottomInk)&&new URLSearchParams(location.search).get('seam')!=='diagnostic')throw new Error('真实长图顶部或最后正文区域为空白');
    bitmap.close();sample.width=1;sample.height=1;
    if(win.MDW.getDoc().text!==before||before!==source)throw new Error('真实长图生成改写了 Markdown');
    if(doc.querySelector('.doc-image-capture'))throw new Error('真实长图临时节点没有清理');
    if([...preview.querySelectorAll('.diagram-block[data-diagram-language=mermaid] svg')].some(svg=>svg.querySelector('foreignObject')))throw new Error('真实文档 Mermaid 留下 foreignObject');
    const seamFailures=seams.filter(seam=>!seam.nonBlank||seam.unique<2);
    /* 文末保留当前阅读排版的底部留白；它可以跨过最后一个内部接缝。正文区域内
       的接缝必须有连续像素，完整覆盖则另由条带几何和底部正文探针保证。 */
    const contentSeamFailures=seamFailures.filter(seam=>result.height-seam.y>4096);
    if(contentSeamFailures.length)throw new Error('真实长图正文接缝附近没有连续内容：'+JSON.stringify(contentSeamFailures));
    window.__documentImageExactSmoke={ready:true,images:1,width:result.width,height:result.height,bytes:result.blob.size,internalStrips:stripGeometry.length,seamsChecked:seams.length,seamFailures,seamSamples:seams,contentSeamsContinuous:!contentSeamFailures.length,topAndBottomInk:topInk&&bottomInk,decoded:true,sourceUnchanged:true,mermaidPureSvg:true,cleanup:true};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__documentImageExactSmoke);
  }catch(error){fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
