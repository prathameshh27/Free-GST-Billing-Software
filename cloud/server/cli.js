// Command-line admin for the server operator.
//   node cloud/server/cli.js create-superadmin <email> [name]   (asks for the password)
//   node cloud/server/cli.js reset-password <email>             (asks for the password)
//   node cloud/server/cli.js list-users
// Reads the same settings as the server (GSP_ENV_FILE=/etc/gst-portal/env).
import crypto from 'crypto';
import readline from 'readline';
import { migrate, q, closePool } from './db.js';
import { hashPassword, passwordProblem, normEmail, emailProblem } from './auth.js';

// Reads a line without echoing it.
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(s); else rl.output.write(''); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function askNewPassword() {
  for (;;) {
    const a = await askHidden('New password: ');
    const problem = passwordProblem(a);
    if (problem) { console.log(`  ${problem}`); continue; }
    const b = await askHidden('Repeat password: ');
    if (a !== b) { console.log('  The passwords differ, try again.'); continue; }
    return a;
  }
}

const [cmd, emailArg, ...nameParts] = process.argv.slice(2);
try {
  await migrate();
  if (cmd === 'create-superadmin') {
    const email = normEmail(emailArg);
    if (emailProblem(email)) throw new Error('Usage: create-superadmin <email> [name]');
    const existing = (await q('SELECT id FROM users WHERE email = ?', [email]))[0];
    const password = await askNewPassword();
    const hash = await hashPassword(password);
    if (existing) {
      await q('UPDATE users SET is_super_admin = 1, password_hash = ?, status = ? WHERE id = ?', [hash, 'active', existing.id]);
      console.log(`  ${email} is now a super admin (password updated).`);
    } else {
      const id = `usr_${crypto.randomBytes(9).toString('base64url')}`;
      await q('INSERT INTO users (id, email, name, password_hash, is_super_admin) VALUES (?, ?, ?, ?, 1)', [id, email, nameParts.join(' '), hash]);
      console.log(`  Super admin ${email} created.`);
    }
  } else if (cmd === 'reset-password') {
    const email = normEmail(emailArg);
    const user = (await q('SELECT id FROM users WHERE email = ?', [email]))[0];
    if (!user) throw new Error(`No user ${email}`);
    await q('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(await askNewPassword()), user.id]);
    await q('DELETE FROM sessions WHERE user_id = ?', [user.id]);
    console.log(`  Password for ${email} changed; their sessions were logged out.`);
  } else if (cmd === 'list-users') {
    for (const u of await q('SELECT email, name, status, is_super_admin FROM users ORDER BY email')) {
      console.log(`  ${u.is_super_admin ? '[super] ' : ''}${u.email}  ${u.name || ''}  ${u.status}`);
    }
  } else {
    console.log('Commands: create-superadmin <email> [name] | reset-password <email> | list-users');
  }
} catch (err) {
  console.error(`  ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
