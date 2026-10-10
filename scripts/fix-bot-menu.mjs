/* OWNER SPEC §6 (2026-10-10): run AFTER the UltraMsg instance is restored.
 * Replaces every canned bot-menu/automation text (e.g. the "Hello to you
 * too! You just triggered an automation rule!" promo) with the approved
 * Tri3M greeting, then syncs. Usage: node scripts/fix-bot-menu.mjs */
const TOKEN = process.env.ULTRAMSG_TOKEN;
const INSTANCE = process.env.ULTRAMSG_INSTANCE_ID ?? 'instance138500';
if (!TOKEN) { console.error('ULTRAMSG_TOKEN required'); process.exit(1); }
const post = (body) => fetch(`https://api.ultramsg.com/${INSTANCE}/instance/settings?token=${TOKEN}`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body) }).then((r) => r.json());

const GREETING = 'Assalam o Alaikum! Main Tri3M Class Agent hoon — class coordination aur academic queries ke liye section students ka AI assistant. Batayein, main aapki kya madad kar sakta hoon?';
const res1 = await post({ update_instance_bot: INSTANCE, instance_bot_sync: 1,
  menu_msg: '', unknown_command_msg: GREETING });
console.log('bot settings publish:', JSON.stringify(res1));
const res2 = await post({ settings: '' }); // no-op — force a fresh GET below
const check = await fetch(`https://api.ultramsg.com/${INSTANCE}/instance/settings?token=${TOKEN}`).then((r) => r.json());
console.log('menu_msg:', JSON.stringify(check.menu_msg ?? ''));
console.log('unknown_command_msg:', JSON.stringify(check.unknown_command_msg ?? ''));
