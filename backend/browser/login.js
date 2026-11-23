'use strict';

const { secureUrl, loginHost } = require('./sites');
const { modalSelector } = require('./page');

// Automatic input is restricted to a first-party login surface, outside post content.
// Cases without a recognizable form go to the dedicated interactive window.
async function tryLogin(page, site, { getCredentials, requestCode, signal, onAttempt, mayContinue }) {
  if (!loginHost(site,secureUrl(page.url()))) return false;
  const origin = new URL(page.url()).origin;
  const loginPage = /^\/(?:signin|login|passport|verify)(?:[/.]|$)/i.test(new URL(page.url()).pathname);
  let form = page.locator(modalSelector).filter({ has: page.locator('input:visible') }).filter({hasText:/登录|验证|sign in/i}).first();
  if (!await form.isVisible() && loginPage) form = page.locator('form').filter({has:page.locator('input:visible')}).first();
  if (!await form.isVisible()) return false;
  async function trusted() {
    signal?.throwIfAborted();
    if (mayContinue?.() === false) return false;
    if (new URL(page.url()).origin !== origin || !await form.isVisible()) return false;
    return form.evaluate((el,origin) => !el.closest('article,.note-content,.RichText,.d_post_content,.thread-content') &&
      [el.closest('form'), ...el.querySelectorAll('form')].filter(Boolean).every(f => new URL(f.action || location.href).origin === origin), origin);
  }
  if (!await trusted()) return false;
  const user = form.locator('input:is([type=tel],[type=email],[autocomplete=username],[name=username i],[name=account i],[placeholder*=手机号],[placeholder*=邮箱],[placeholder*=账号]):visible').first();
  const password = form.locator('input[type=password]:visible').first();
  const code = form.locator('input:is([autocomplete=one-time-code],[placeholder*=验证码],[name=smsCode i],[name=verification_code i]):visible').first();
  if (!await password.isVisible() && !await code.isVisible()) return false;
  let attempted = false;
  const beginAttempt = () => attempted || (attempted = onAttempt?.() !== false);
  const supplyCode = async () => {
    if (!requestCode || !await trusted() || await form.locator('img:is([alt*=验证码],[class*=captcha i]):visible').count()) return false;
    const hint = ((await code.getAttribute('placeholder')) || '') + ' ' + (await form.innerText()).slice(0,700);
    if (/图[片形]验证码|算术题|点选|滑块/.test(hint)) return false;
    const email = /邮件|邮箱/.test(hint);
    const sms = /短信|手机|\d{3}\*{3,}\d{2,4}/.test(hint);
    if (!email && !sms) return false;
    const method = email && !sms ? 'email' : 'sms';
    const alreadySent = /已发送|已发[至送]|发送至|发送到|\d+\s*(?:秒|s)\s*(?:后|重新|重发)|(?:重发|重新发送).{0,5}\d+\s*(?:s|秒)/i.test(hint);
    if (!alreadySent) {
      const send = form.getByText(/^(?:获取|发送)(?:短信|手机|邮箱|邮件)?验证码$/).first();
      if (!await send.isVisible() || !beginAttempt()) return false;
      await send.click({ timeout: 2500 });
    }
    if (!await trusted() || !beginAttempt()) return false;
    const otp = await requestCode({ site, method, signal });
    if (typeof otp !== 'string' || !/^[a-z0-9]{4,10}$/i.test(otp) || !await trusted()) return false;
    await code.fill(otp, { timeout: 2500 });
    return true;
  };
  if (await user.isVisible() || await password.isVisible()) {
    const credentials = await getCredentials?.({ site, signal });
    if (!credentials || !await trusted()) return false;
    if (await user.isVisible()) await user.fill(credentials.username, { timeout: 2500 });
    if (await password.isVisible()) {
      if (!credentials.password || !await trusted()) return false;
      await password.fill(credentials.password, { timeout: 2500 });
    }
  }
  const codeAtStart = await code.isVisible();
  if (codeAtStart && !await supplyCode()) return false;
  const submitLabel = /^\s*(?:登\s*录|验证并登录|登录\/注册|验证|确认|下一步|Sign in)\s*$/i;
  const submit = form.getByRole('button',{name:submitLabel}).or(
    form.locator('.submit,.login-button,.login-btn,.tang-pass-login-submit').filter({hasText:submitLabel})).first();
  if (!await submit.isVisible() || !await trusted() || !beginAttempt()) return false;
  await submit.click({ timeout: 3500 });
  if (!codeAtStart) {
    await Promise.race([form.waitFor({state:'hidden',timeout:4500}),code.waitFor({state:'visible',timeout:4500})]).catch(()=>{});
    if (await code.isVisible()) {
      if (!await supplyCode() || !await trusted() || !await submit.isVisible()) return false;
      await submit.click({timeout:3500});
    }
  }
  await form.waitFor({ state: 'hidden', timeout: 4500 }).catch(() => {});
  return true;
}

module.exports = { tryLogin };
