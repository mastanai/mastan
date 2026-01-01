// Browser-only mailbox checks against redesign-preview's invented store. Never sends mail.
import assert from 'node:assert/strict';
export async function checkMail(page,{width,light}) {
  let sends=0;
  const sent=request=>{if(new URL(request.url()).pathname.endsWith('/send'))sends++;};
  page.on('request',sent);
  const ready=()=>page.waitForFunction(()=>document.querySelector('.mail-rows .mail-row, .mail-rows .empty'));
  // The right side of a row holds hover actions on desktop, so open rows from the sender side.
  const openRow=locator=>locator.click({position:{x:24,y:12}});
  const leave=async()=>{const back=page.locator('.mail-reading-tools .mail-back');if(await back.isVisible())await back.click();else{await page.locator('body').click({position:{x:2,y:300}});await page.keyboard.press('u');}};
  const rail=async()=>{
    if(!await page.locator('.mail-rail').isVisible())await page.getByRole('button',{name:'Folders',exact:true}).click();
  };
  const origin=new URL(page.url()).origin;
  try {
    await ready();
    if(await page.locator('.mail-row').count()) {
      await page.getByRole('checkbox',{name:'Select all messages on this page'}).check();
      assert.match(await page.locator('.mail-toolbar').innerText(),/selected/);
      await page.getByRole('checkbox',{name:'Select all messages on this page'}).uncheck();
      await openRow(page.locator('.mail-row-open').first());
      await page.waitForSelector('.mail-message');
      assert.ok(await page.locator('.mail-message').count()>=1);
      await leave();
    }
    await rail();
    await page.locator('.mail-rail').getByRole('button',{name:'Compose',exact:true}).click();
    const composer=page.locator('.mail-composer'),subject=`Browser mailbox check ${width} ${light?'light':'dark'}`;
    await composer.getByRole('textbox',{name:'TO',exact:true}).fill('reader@example.net');
    await composer.getByRole('textbox',{name:'TO',exact:true}).press('Enter');
    await composer.getByRole('textbox',{name:'Subject',exact:true}).fill(subject);
    await composer.getByRole('textbox',{name:'Message',exact:true}).fill('Invented browser check. Plain text only.');
    await composer.getByRole('button',{name:'Send',exact:true}).click();
    await page.waitForSelector('.mail-undo');
    assert.equal(sends,0,'Send saves a draft and holds it client-side');
    await page.locator('.mail-undo').getByRole('button',{name:'Undo',exact:true}).click();
    await page.waitForSelector('.mail-undo',{state:'detached'});
    assert.equal(sends,0,'Undo never submits mail');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Composer fits the viewport');
    await composer.getByRole('button',{name:'Close',exact:true}).click();
    await composer.waitFor({state:'detached'});
    await rail();
    await page.locator('.mail-rail').getByRole('link',{name:/^Drafts/}).click();
    const draft=page.locator('.mail-row-open').filter({hasText:subject});
    await draft.waitFor();await openRow(draft);
    await composer.waitFor();
    assert.equal(await composer.getByRole('textbox',{name:'Subject',exact:true}).inputValue(),subject);
    await composer.getByRole('button',{name:'Discard',exact:true}).click();
    await composer.waitFor({state:'detached'});
    assert.equal(sends,0,'Reopening and discarding a draft never sends it');
    await page.goto(`${origin}/mail`,{waitUntil:'domcontentloaded'});await ready();
    const newsletter=page.locator('.mail-row-open').filter({hasText:'Paper samples 5'});
    if(await newsletter.count()) {
      await openRow(newsletter.first());await page.waitForSelector('.mail-html');
      const iframe=page.locator('.mail-html').first(),sandbox=await iframe.getAttribute('sandbox');
      assert.doesNotMatch(sandbox,/allow-scripts|allow-same-origin/);
      assert.equal(await page.getByRole('button',{name:'Show images',exact:true}).count(),1);
      const src=await iframe.getAttribute('src');assert.ok(!new URL(src,origin).searchParams.has('images'));
      const body=await page.request.get(new URL(src,origin).href),csp=body.headers()['content-security-policy'];
      assert.match(csp,/default-src 'none'/);assert.doesNotMatch(csp,/img-src[^;]*(https:|http:)|allow-scripts|allow-same-origin/);
      await leave();
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Mailbox fits the viewport');
  } finally { page.off('request',sent); }
}
