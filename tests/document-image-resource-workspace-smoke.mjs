const fail=(message)=>{window.__documentImageResourceSmoke={error:String(message)};document.body.dataset.rendered='error';document.title=String(message)};
const frame=document.createElement('iframe');frame.src='../src/views/markdown/index.html';
frame.addEventListener('load',()=>{const win=frame.contentWindow,doc=frame.contentDocument,started=Date.now();
  (function wait(){if(win.MDW&&win.DocsmithDocumentImage&&win.modernScreenshot){run();return}if(Date.now()-started>20000)return fail('工作台或图片运行时没有启动');setTimeout(wait,60)})();
  async function run(){try{
    const httpUrl=new URL('../src/icons/icon-128.png',location.href).href;
    win.MDW.setText(`# HTTP 图片\n\n![same-origin](${httpUrl})`);
    await new Promise((resolve,reject)=>{const img=doc.querySelector('.doc img');if(!img)return reject(new Error('HTTP fixture 没有渲染 img'));if(img.complete)return img.naturalWidth?resolve():reject(new Error('HTTP fixture 解码失败：'+img.src));img.addEventListener('load',resolve,{once:true});img.addEventListener('error',()=>reject(new Error('HTTP fixture 加载失败：'+img.src)),{once:true})});
    const http=await win.MDW.buildDocumentImages();
    if(http.mode!=='single'||http.blob.type!=='image/png'||http.blob.size<1000)throw new Error('同源 HTTP 图片没有生成 PNG');

    const canvas=doc.createElement('canvas');canvas.width=18;canvas.height=18;const ctx=canvas.getContext('2d');ctx.fillStyle='#1f6feb';ctx.fillRect(0,0,18,18);ctx.fillStyle='#fff';ctx.fillRect(5,5,8,8);
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const blobUrl=win.URL.createObjectURL(blob);
    try{
      win.MDW.setText('# Blob 图片');
      const live=doc.querySelector('.doc .blk')||doc.querySelector('.doc');const blobImg=doc.createElement('img');blobImg.alt='blob';blobImg.src=blobUrl;live.appendChild(blobImg);
      await new Promise((resolve,reject)=>{const img=doc.querySelector('.doc img');if(!img)return reject(new Error('Blob fixture 没有渲染 img'));if(img.complete)return img.naturalWidth?resolve():reject(new Error('Blob fixture 解码失败：'+img.src));img.addEventListener('load',resolve,{once:true});img.addEventListener('error',()=>reject(new Error('Blob fixture 加载失败：'+img.src)),{once:true})});
      const local=await win.MDW.buildDocumentImages();
      if(local.mode!=='single'||local.blob.type!=='image/png'||local.blob.size<1000)throw new Error('有效 Blob 图片没有生成 PNG');
    }finally{win.URL.revokeObjectURL(blobUrl)}

    win.MDW.setText('# 聚合失败\n\n![one](data:text/plain,one)\n\n![two](data:application/json,two)');
    let error='';try{await win.MDW.buildDocumentImages()}catch(e){error=String(e&&e.message)}
    if(!/2 张(?:正文)?图片无法读取/.test(error)||!error.includes('text/plain')||!error.includes('application/json'))throw new Error('图片错误没有聚合：'+error);
    if(doc.querySelector('.doc-image-capture'))throw new Error('资源失败后捕获节点没有清理');

    window.__documentImageResourceSmoke={ready:true,http:true,blob:true,aggregateFailure:true,error};
    document.body.dataset.rendered='true';document.title=JSON.stringify(window.__documentImageResourceSmoke);
  }catch(error){fail(error.message||error)}}
});document.querySelector('#mount').append(frame);
