// mastan-me-admin <command> [args]. Each module exports {commands: {name: {help, run(args)}}}.
const modules = ['./auth.js', './workspace.js', './ops.js'];
const commands = {};
for (const m of modules) {
  try { Object.assign(commands, (await import(m)).commands); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
}
const [name, ...args] = process.argv.slice(2);
if (!name || !commands[name]) {
  console.log('Usage: mastan-me-admin <command>\n' + Object.entries(commands).map(([k, v]) => `  ${k.padEnd(18)} ${v.help}`).join('\n'));
  process.exit(name ? 2 : 0);
}
try { await commands[name].run(args); }
catch (e) { console.error(e.message); process.exitCode = 2; }
