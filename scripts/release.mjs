#!/usr/bin/env node
/*
 * Выпуск новой версии Zvuk Glass для Android: поднимает номер, собирает подписанный APK и публикует его
 * в GitHub Releases репозитория zvuk-glass-android. Установленные приложения увидят релиз и предложат
 * обновиться (установку подтверждает Android).
 *
 *   npm run release              → 1.0.0 → 1.0.1
 *   npm run release -- 3         → +3 к последней цифре (по числу изменений): 1.0.1 → 1.0.4
 *   npm run release -- 1.2.0     → ровно эта версия
 *   npm run release -- current   → выпустить текущую версию без изменения номера
 *   добавьте --notes "что нового" — текст появится в описании релиза и в приложении
 *
 * Нужно: Rust с целями Android, Node.js, Android SDK + NDK, GitHub CLI со входом (gh auth login --web)
 * и ключ подписи %USERPROFILE%\.tauri\zvuk-glass-android.jks (+ .properties). Без ключа установленные
 * приложения не примут обновление. Токен GitHub передаётся только дочерним процессам — нигде не печатается.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const signing = join(homedir(), '.tauri', 'zvuk-glass-android.properties');
const OWNER = 'GhostOFFantasy';
const REPO = 'zvuk-glass-android';
const APK = 'Zvuk-Glass-Android.apk';

const args = process.argv.slice(2);
const notesAt = args.indexOf('--notes');
const notesArg = notesAt >= 0 ? args.splice(notesAt, 2)[1] || '' : '';
const bump = args[0] || '1';

const fail = (msg) => {
  console.error('\n✖ ' + msg);
  process.exit(1);
};
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const step = (msg) => console.log('\n▸ ' + msg);
const withPath = (env) => ({ ...env, PATH: [join(homedir(), '.cargo', 'bin'), dirname(process.execPath), env.PATH || env.Path || ''].join(';') });

const GH = (() => {
  try {
    run('gh', ['--version']);
    return 'gh';
  } catch {
    const local = 'C:\\Program Files\\GitHub CLI\\gh.exe';
    if (existsSync(local)) return local;
  }
  fail('Не найден GitHub CLI (gh). Установите: winget install GitHub.cli');
})();

// ---------- Проверки ----------
let token = '';
try {
  token = run(GH, ['auth', 'token']);
} catch {
  fail('Нет входа в GitHub. Выполните: gh auth login --web');
}
if (!existsSync(signing)) fail(`Нет ключа подписи: ${signing}. Без него установленные приложения не примут новую версию.`);
if (run('git', ['status', '--porcelain'])) fail('Есть незакоммиченные изменения — сначала сделайте коммит.');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const ghEnv = { env: { ...process.env, GH_TOKEN: token } };
const R = ['-R', `${OWNER}/${REPO}`];

// ---------- Номер версии: последняя цифра растёт на число изменений ----------
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = pkg.version;
let next = cur;
if (bump !== 'current') {
  const [ma, mi, pa] = cur.split('.').map(Number);
  if (/^\+?\d+$/.test(bump)) next = `${ma}.${mi}.${pa + Number(bump)}`;
  else if (/^\d+\.\d+\.\d+$/.test(bump)) next = bump;
  else fail(`Непонятная версия «${bump}». Используйте число изменений, current или x.y.z`);
}
const tag = 'v' + next;
const tagExists = Boolean(run('git', ['tag', '--list', tag]));
if (tagExists && run('git', ['rev-list', '-n', '1', tag]) !== run('git', ['rev-parse', 'HEAD']))
  fail(`Тег ${tag} уже существует — эта версия уже выпускалась. Выберите другой номер.`);

// Код версии для Android растёт вместе с номером. Начало с 3 000 000 — чтобы версия 1.x вставала
// поверх пробной сборки 2.3.0 из общего проекта (у неё код 2 003 000).
const versionCode = (v) => {
  const [ma, mi, pa] = v.split('.').map(Number);
  return 3_000_000 + ma * 10_000 + mi * 100 + pa;
};

if (next !== cur) {
  step(`Версия ${cur} → ${next}`);
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(cargoPath, readFileSync(cargoPath, 'utf8').replace(/^version = "[^"]+"/m, `version = "${next}"`));
  const conf = JSON.parse(readFileSync(confPath, 'utf8'));
  conf.bundle.android = { ...(conf.bundle.android || {}), versionCode: versionCode(next) };
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');
  spawnSync('cargo', ['update', '--workspace', '--offline'], { cwd: join(root, 'src-tauri'), stdio: 'ignore', env: withPath(process.env), shell: false });
  run('git', ['add', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']);
  run('git', ['commit', '-m', `Версия ${next}`]);
} else step(`Выпускаем текущую версию ${cur}`);

step('Отправляем код на GitHub');
if (!tagExists) run('git', ['tag', tag]);
for (const ref of [branch, tag]) {
  if (spawnSync('git', ['push', 'origin', ref], { cwd: root, stdio: 'inherit' }).status !== 0) fail(`Не удалось отправить ${ref} на GitHub`);
}

// Релиз создаём черновиком: приложения его не видят, пока файлы не загружены и не проверены
let existing = null;
try {
  existing = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'isDraft'], ghEnv));
} catch {}
if (existing && !existing.isDraft) fail(`Релиз ${tag} уже опубликован на GitHub. Выберите другой номер версии.`);
const notes = notesArg || `Zvuk Glass для Android ${next}`;
if (!existing) run(GH, ['release', 'create', tag, ...R, '--draft', '--verify-tag', '--title', `Zvuk Glass для Android ${next}`, '--notes', notes], ghEnv);

step('Собираем APK (несколько минут)');
const b = spawnSync(process.execPath, [join(root, 'scripts', 'android.mjs'), '--release'], { cwd: root, stdio: 'inherit', env: withPath(process.env) });
const built = join(root, 'dist', 'android', `Zvuk-Glass-${next}.apk`);
if (b.status !== 0 || !existsSync(built)) fail('Сборка не удалась (см. вывод выше). Черновик релиза остался — после исправления: npm run release -- current');

// ---------- Файлы релиза ----------
const dist = join(root, 'dist', 'release');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(built, join(dist, APK));
// приложение читает отсюда номер и описание новой версии, APK качает по постоянному адресу
writeFileSync(join(dist, 'latest.json'), JSON.stringify({ version: next, notes, pub_date: new Date().toISOString() }, null, 2));

step('Загружаем файлы в релиз');
const files = [join(dist, APK), join(dist, 'latest.json')];
if (spawnSync(GH, ['release', 'upload', tag, ...R, '--clobber', ...files], { cwd: root, stdio: 'inherit', ...ghEnv }).status !== 0)
  fail('Не удалось загрузить файлы. Черновик остался — запустите: npm run release -- current');
const assets = JSON.parse(run(GH, ['release', 'view', tag, ...R, '--json', 'assets'], ghEnv)).assets.map((a) => a.name);
for (const need of [APK, 'latest.json']) if (!assets.includes(need)) fail(`В черновике ${tag} нет файла ${need}`);

step('Публикуем релиз');
run(GH, ['release', 'edit', tag, ...R, '--draft=false', '--latest', '--notes', notes], ghEnv);

console.log(`\n✔ Готово: ${tag} опубликован — https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
console.log('  Установленные приложения предложат обновиться в течение нескольких часов (или сразу — «Настройки → О программе → Проверить обновления»).');
