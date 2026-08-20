const fail=(message)=>{window.__exportFormatsSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.docx&&doc.querySelector('.ex-split')){run();return}if(Date.now()-started>20000)return fail('工作台或导出运行时没有启动');setTimeout(wait,60)})();
  async function run(){const originalURL=win.URL.createObjectURL.bind(win.URL),originalClick=win.HTMLAnchorElement.prototype.click,originalPrint=win.print;try{
    const downloads=[],events=[];win.DSSaveBlob=async(blob,name)=>{downloads.push({url:'shell:'+downloads.length,blob,name})};win.URL.createObjectURL=(blob)=>{const url=originalURL(blob);downloads.push({url,blob,name:''});return url};win.HTMLAnchorElement.prototype.click=function(){const hit=downloads.find(x=>x.url===this.href);if(hit)hit.name=this.download||''};win.addEventListener('docsmith:export',e=>events.push(e.detail.format));
    win.MDW.setText('# 导出回归\n\n**加粗**、公式 $x^2$ 和表格。\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    const html=await win.MDW.buildStandaloneHtml();
    if(!/^<!doctype html>/i.test(html)||!html.includes('加粗')||!html.includes('<style')||!html.includes('<article'))throw new Error('独立 HTML 内容不完整');
    await win.MDW.exportStandaloneHtml();await new Promise(r=>setTimeout(r,30));
    const htmlDownload=downloads.find(x=>x.name.endsWith('.html'));if(!htmlDownload||htmlDownload.blob.type!=='text/html;charset=utf-8')throw new Error('网页导出下载参数错误');
    await win.MDW.exportWord();await new Promise(r=>setTimeout(r,30));
    const word=downloads.find(x=>x.name.endsWith('.docx'));if(!word||!word.blob.type.includes('officedocument.wordprocessingml.document')||word.blob.size<1000)throw new Error('Word 导出没有生成有效 docx');
    const bytes=new Uint8Array(await word.blob.arrayBuffer());if(String.fromCharCode(...bytes.slice(0,2))!=='PK')throw new Error('Word 成品不是 Open XML ZIP');
    let printed=0;win.print=()=>{printed++};await win.MDW.exportPdf();if(printed!==0)throw new Error('iframe PDF 本应走新标签页兜底');
    if(events.filter(x=>x==='html').length!==1||events.filter(x=>x==='docx').length!==1)throw new Error('既有格式导出事件错误：'+events.join(','));
    if(doc.querySelector('.doc-image-capture'))throw new Error('既有导出遗留图片捕获节点');
    win.URL.createObjectURL=originalURL;win.HTMLAnchorElement.prototype.click=originalClick;win.print=originalPrint;
    window.__exportFormatsSmoke={ready:true,html:true,word:true,pdfFallback:true,events,wordSize:word.blob.size};document.body.dataset.rendered='true';document.title=JSON.stringify(window.__exportFormatsSmoke);
  }catch(error){win.URL.createObjectURL=originalURL;win.HTMLAnchorElement.prototype.click=originalClick;win.print=originalPrint;fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
