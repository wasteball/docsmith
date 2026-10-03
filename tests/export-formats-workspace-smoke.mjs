const fail=(message)=>{window.__exportFormatsSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.docx&&doc.querySelector('.ex-split')){run();return}if(Date.now()-started>20000)return fail('工作台或导出运行时没有启动');setTimeout(wait,60)})();
  async function run(){const originalURL=win.URL.createObjectURL.bind(win.URL),originalClick=win.HTMLAnchorElement.prototype.click,originalPrint=win.print,originalPrintHtml=win.DSPrintHtml;try{
    const downloads=[],events=[],printPages=[];win.DSSaveBlob=async(blob,name)=>{downloads.push({url:'shell:'+downloads.length,blob,name})};win.URL.createObjectURL=(blob)=>{const url=originalURL(blob);downloads.push({url,blob,name:''});return url};win.HTMLAnchorElement.prototype.click=function(){const hit=downloads.find(x=>x.url===this.href);if(hit)hit.name=this.download||''};win.addEventListener('docsmith:export',e=>events.push(e.detail.format));
    const source='# 导出回归\n\n**加粗**、公式 $x^2$ 和表格。\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const transfer=new win.DataTransfer();transfer.items.add(new win.File([source],'季度计划 & 决策.md',{type:'text/markdown'}));
    const input=doc.querySelector('#fileInput');input.files=transfer.files;input.dispatchEvent(new win.Event('change',{bubbles:true}));
    const deadline=Date.now()+10000;while(win.MDW.getDoc()?.text!==source){if(Date.now()>deadline)throw new Error('测试文件未加载');await new Promise(r=>setTimeout(r,30))}
    const html=await win.MDW.buildStandaloneHtml();
    if(!/^<!doctype html>/i.test(html)||!html.includes('加粗')||!html.includes('<style')||!html.includes('<article'))throw new Error('独立 HTML 内容不完整');
    await win.MDW.exportStandaloneHtml();await new Promise(r=>setTimeout(r,30));
    const htmlDownload=downloads.find(x=>x.name.endsWith('.html'));if(!htmlDownload||htmlDownload.blob.type!=='text/html;charset=utf-8')throw new Error('网页导出下载参数错误');
    await win.MDW.exportWord();await new Promise(r=>setTimeout(r,30));
    const word=downloads.find(x=>x.name.endsWith('.docx'));if(!word||!word.blob.type.includes('officedocument.wordprocessingml.document')||word.blob.size<1000)throw new Error('Word 导出没有生成有效 docx');
    if(word.name!=='季度计划 & 决策.docx')throw new Error('Word 文件名与源文件不一致');
    const bytes=new Uint8Array(await word.blob.arrayBuffer());if(String.fromCharCode(...bytes.slice(0,2))!=='PK')throw new Error('Word 成品不是 Open XML ZIP');
    let printed=0;win.print=()=>{printed++};win.DSPrintHtml=async html=>{printPages.push(html);return true};
    const pdf=await win.MDW.exportPdf();if(printed!==0||pdf!==true||printPages.length!==1)throw new Error('PDF 没有交付独立打印页');
    const printDoc=new win.DOMParser().parseFromString(printPages[0],'text/html');
    if(printDoc.title!=='季度计划 & 决策'||!printDoc.querySelector('article.doc')||printDoc.querySelector('script'))throw new Error('PDF 文件名或静态正文错误');
    win.DSPrintHtml=async()=>false;
    if(await win.MDW.exportPdf()!==false)throw new Error('打印页被拦截仍报告成功');
    const lastFormat=win.DSPrefs.get('export.lastFormat');
    doc.querySelector('.ex-caret').click();doc.querySelector('[data-fmt="pdf"]').click();
    const menuDeadline=Date.now()+10000;while(doc.querySelector('.ex-split').getAttribute('aria-busy')==='true'){if(Date.now()>menuDeadline)throw new Error('PDF 菜单没有完成');await new Promise(r=>setTimeout(r,30))}
    if(win.DSPrefs.get('export.lastFormat')!==lastFormat)throw new Error('失败的 PDF 导出改变了默认格式');
    const pagesBefore=printPages.length;win.DSPrintHtml=async html=>{printPages.push(html);return true};
    win.MDW.setText('# 无效图表\n\n```mermaid\nflowchart TD\nA -->\n```');
    if(await win.MDW.exportPdf()!==false||printPages.length!==pagesBefore)throw new Error('未渲染成功的图表进入 PDF');
    if(events.filter(x=>x==='html').length!==1||events.filter(x=>x==='docx').length!==1)throw new Error('既有格式导出事件错误：'+events.join(','));
    if(doc.querySelector('.doc-image-capture'))throw new Error('既有导出遗留图片捕获节点');
    window.__exportFormatsSmoke={ready:true,html:true,word:true,pdfStandalone:true,pdfTitle:printDoc.title,blockedPdf:true,events,wordSize:word.blob.size};document.body.dataset.rendered='true';document.title=JSON.stringify(window.__exportFormatsSmoke);
  }catch(error){fail(error.message||error)}finally{win.URL.createObjectURL=originalURL;win.HTMLAnchorElement.prototype.click=originalClick;win.print=originalPrint;win.DSPrintHtml=originalPrintHtml}}
});document.querySelector('#mount').append(frame);
